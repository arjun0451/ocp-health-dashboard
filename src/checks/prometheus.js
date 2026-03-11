'use strict';
/**
 * prometheus.js — Prometheus / Thanos metrics checks
 * ===================================================
 * Queries match the original bash monitoring script exactly.
 * All thresholds read from env vars (ocp-health-metrics-config ConfigMap).
 *
 *  GROUP compute   1. cpu_usage        2. memory_usage     3. oom_killed
 *  GROUP storage   4. pvc_usage        5. node_filesystem
 *  GROUP etcd      6. etcd_db_size     7. etcd_rtt
 *  GROUP alerts    8. active_alerts
 */

const https   = require('https');
const { run } = require('../executor');
const logger  = require('../logger');

function env(k,d){ const v=process.env[k]; return(v!==undefined&&v!=='')?v:d; }
function envInt(k,d){ return parseInt(env(k,String(d)),10); }
function envFloat(k,d){ return parseFloat(env(k,String(d))); }

function getThresholds(){
  return {
    cpuThresholdPct : envFloat('PROM_CPU_THRESHOLD',           90),
    memThresholdPct : envFloat('PROM_MEM_THRESHOLD',           80),
    oomWindow       : env    ('PROM_OOM_WINDOW',              '1h'),
    oomMinCount     : envInt ('PROM_OOM_MIN_COUNT',             1),
    topN            : envInt ('PROM_TOP_N',                    10),
    pvcThresholdPct : envFloat('PROM_PVC_THRESHOLD',           70),
    fsUsedThreshold : envFloat('PROM_FS_USED_THRESHOLD',       90),
    etcdDbBytes     : envFloat('PROM_ETCD_DB_BYTES',  8*1024**3),
    etcdRttMs       : envFloat('PROM_ETCD_RTT_MS',            100),
    alertSeverities : env    ('PROM_ALERT_SEVERITIES','critical,warning'),
  };
}

let _tokenCache=null, _tokenExpiry=0, _thanosHost=null;

async function getThanosHost(){
  const override=env('THANOS_HOST','');
  if(override) return override;
  if(_thanosHost) return _thanosHost;
  const out=await run(['get','route','thanos-querier','-n','openshift-monitoring','-o','jsonpath={.spec.host}'],15000);
  _thanosHost=out.trim();
  logger.info(`Thanos host: ${_thanosHost}`);
  return _thanosHost;
}

async function getToken(){
  if(_tokenCache&&Date.now()<_tokenExpiry) return _tokenCache;
  const ns=env('METRICS_TOKEN_NS','openshift-monitoring');
  const sa=env('METRICS_TOKEN_SA','prometheus-k8s');
  const raw=await run(['create','token',sa,'-n',ns,'--duration=600s'],20000);
  _tokenCache=raw.trim();
  _tokenExpiry=Date.now()+9*60*1000;
  logger.debug(`Token refreshed (${ns}/${sa})`);
  return _tokenCache;
}

async function promQuery(host,token,query){
  return new Promise((resolve,reject)=>{
    const body='query='+encodeURIComponent(query);
    const opts={
      hostname:host,path:'/api/v1/query',method:'POST',
      rejectUnauthorized:false,
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body)},
    };
    const req=https.request(opts,(res)=>{
      let data='';
      res.on('data',c=>{data+=c;});
      res.on('end',()=>{
        if(res.statusCode!==200) return reject(new Error(`Thanos HTTP ${res.statusCode}: ${data.slice(0,300)}`));
        try{
          const p=JSON.parse(data);
          if(p.status!=='success') return reject(new Error(`Thanos: ${p.error||JSON.stringify(p).slice(0,200)}`));
          resolve(p.data.result||[]);
        }catch(e){reject(new Error(`JSON: ${e.message}`));}
      });
    });
    req.on('error',reject);
    req.setTimeout(30000,()=>{req.destroy(new Error('timeout'));});
    req.write(body);req.end();
  });
}

// 1. CPU usage vs limit (script: print_top_cpu_usage, threshold 90%)
async function checkCpuUsage(host,token,thresh,topN){
  const q=`(sum(rate(container_cpu_usage_seconds_total{container!=""}[5m]))by(pod,namespace)/sum(kube_pod_container_resource_limits{resource="cpu",unit="core"})by(pod,namespace))*100`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>({namespace:r.metric.namespace||'—',pod:r.metric.pod||'—',value:parseFloat(r.value[1])}))
    .filter(r=>!isNaN(r.value)&&r.value>=thresh)
    .sort((a,b)=>b.value-a.value).slice(0,topN)
    .map(r=>({...r,valueDisplay:r.value.toFixed(1)+'%',unit:'%'}));
}

// 2. Memory working-set vs limit (script: print_high_memory_usage, threshold 0.8 → 80%)
async function checkMemoryUsage(host,token,thresh,topN){
  const ratio=thresh/100;
  const q=`(sum(container_memory_working_set_bytes{container!=""})by(pod,namespace)/sum(kube_pod_container_resource_limits{resource="memory",unit="byte"})by(pod,namespace))`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>({namespace:r.metric.namespace||'—',pod:r.metric.pod||'—',value:parseFloat(r.value[1])*100,rawRatio:parseFloat(r.value[1])}))
    .filter(r=>!isNaN(r.rawRatio)&&r.rawRatio>ratio)
    .sort((a,b)=>b.value-a.value).slice(0,topN)
    .map(r=>({...r,valueDisplay:r.value.toFixed(1)+'%',unit:'%'}));
}

// 3. OOMKilled (script: print_oom_killed, window 1h)
async function checkOOMKilled(host,token,window,minCount){
  const q=`count_over_time(kube_pod_container_status_last_terminated_reason{reason="OOMKilled"}[${window}])`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>({namespace:r.metric.namespace||'—',pod:r.metric.pod||'—',container:r.metric.container||'—',value:parseFloat(r.value[1])}))
    .filter(r=>!isNaN(r.value)&&r.value>=minCount)
    .sort((a,b)=>b.value-a.value)
    .map(r=>({...r,valueDisplay:String(Math.round(r.value)),unit:'kills'}));
}

// 4. PVC usage > threshold% (script: print_pvc_usage, threshold 70)
async function checkPVCUsage(host,token,thresh){
  const q=`(kubelet_volume_stats_used_bytes/kubelet_volume_stats_capacity_bytes)*100>${thresh}`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>({namespace:r.metric.namespace||'—',pvc:r.metric.persistentvolumeclaim||'—',value:parseFloat(r.value[1])}))
    .filter(r=>!isNaN(r.value))
    .sort((a,b)=>b.value-a.value)
    .map(r=>({...r,valueDisplay:r.value.toFixed(1)+'%',unit:'%'}));
}

// 5. Node filesystem — root mount only (mountpoint="/"), excludes ibmc-s3fs & read-only
async function checkNodeFilesystem(host,token,fsUsedThresh){
  const freePct=100-fsUsedThresh;
  // mountpoint="/" added to all three metric selectors so only the root filesystem is checked.
  // This prevents spurious alerts from overlay/container/tmpfs mounts on every node.
  const q=`((node_filesystem_avail_bytes{fstype!="",job="node-exporter",mountpoint="/",mountpoint!~"/var/lib/ibmc-s3fs.*"}/node_filesystem_size_bytes{fstype!="",job="node-exporter",mountpoint="/",mountpoint!~"/var/lib/ibmc-s3fs.*"}*100)<${freePct})and node_filesystem_readonly{fstype!="",job="node-exporter",mountpoint="/",mountpoint!~"/var/lib/ibmc-s3fs.*"}==0`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>{const fp=parseFloat(r.value[1]);return{instance:r.metric.instance||'—',mountpoint:r.metric.mountpoint||'—',device:r.metric.device||'—',fstype:r.metric.fstype||'—',freePct:fp,value:100-fp};})
    .filter(r=>!isNaN(r.value))
    .sort((a,b)=>b.value-a.value)
    .map(r=>({...r,valueDisplay:r.value.toFixed(1)+'%',unit:'% used'}));
}

// 6. etcd DB size (script: print_etcd_db_size)
async function checkEtcdDBSize(host,token,warnBytes){
  const q=`etcd_mvcc_db_total_size_in_bytes{job=~".*etcd.*",job="etcd"}`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>{const bytes=parseFloat(r.value[1]);return{instance:r.metric.instance||r.metric.pod||'—',value:bytes,valueDisplay:(bytes/1024**3).toFixed(2)+' GB',unit:'bytes',warn:bytes>warnBytes};})
    .filter(r=>!isNaN(r.value))
    .sort((a,b)=>b.value-a.value);
}

// 7. etcd peer RTT p99 (script: print_etcd_rtt)
async function checkEtcdRTT(host,token,warnMs){
  const q=`histogram_quantile(0.99,sum by(instance,le)(rate(etcd_network_peer_round_trip_time_seconds_bucket{job=~".*etcd.*",job="etcd"}[5m])))*1000`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>{const ms=parseFloat(r.value[1]);return{instance:r.metric.instance||'—',value:ms,valueDisplay:isNaN(ms)?'N/A':ms.toFixed(2)+' ms',unit:'ms',warn:ms>warnMs};})
    .filter(r=>!isNaN(r.value))
    .sort((a,b)=>b.value-a.value);
}

// 8. Active alerts (script: print_alert_summary)
async function checkActiveAlerts(host,token,severities){
  const sevRe=severities.split(',').map(s=>s.trim()).filter(Boolean).join('|');
  const q=`sum by(alertname,namespace,severity,alertstate)(ALERTS{alertstate=~"firing|pending",severity=~"${sevRe}"})`;
  const raw=await promQuery(host,token,q);
  return raw
    .map(r=>({
      alertname:r.metric.alertname||'—',namespace:r.metric.namespace||'N/A',
      severity:r.metric.severity||'—',state:r.metric.alertstate||'—',
      value:parseFloat(r.value[1])||1,valueDisplay:r.metric.alertstate||'firing',unit:'count',
      crit:r.metric.severity==='critical',warn:r.metric.severity==='warning',
    }))
    .filter(r=>!isNaN(r.value))
    .sort((a,b)=>{const o={critical:0,warning:1};return((o[a.severity]??2)-(o[b.severity]??2))||a.alertname.localeCompare(b.alertname);});
}

// ── Result cache ──────────────────────────────────────────────────────────
let _cache=null, _cacheTime=0;

async function getAllMetrics(force=false){
  const cacheSecs=envInt('PROM_CACHE_SECS',300);
  if(!force&&_cache&&(Date.now()-_cacheTime)<cacheSecs*1000){ logger.debug('Metrics: cached'); return _cache; }

  const T=getThresholds();
  let host,token;
  try{ [host,token]=await Promise.all([getThanosHost(),getToken()]); }
  catch(e){ throw new Error(`Thanos/token: ${e.message}`); }

  const t0=Date.now();
  logger.info(`Prometheus: querying ${host}`);

  const [r1,r2,r3,r4,r5,r6,r7,r8]=await Promise.allSettled([
    checkCpuUsage(host,token,T.cpuThresholdPct,T.topN),
    checkMemoryUsage(host,token,T.memThresholdPct,T.topN),
    checkOOMKilled(host,token,T.oomWindow,T.oomMinCount),
    checkPVCUsage(host,token,T.pvcThresholdPct),
    checkNodeFilesystem(host,token,T.fsUsedThreshold),
    checkEtcdDBSize(host,token,T.etcdDbBytes),
    checkEtcdRTT(host,token,T.etcdRttMs),
    checkActiveAlerts(host,token,T.alertSeverities),
  ]);
  function ok(r,id){ if(r.status==='fulfilled') return{rows:r.value,error:null}; logger.warn(`Prom[${id}]: ${r.reason.message}`); return{rows:[],error:r.reason.message}; }
  const cpu=ok(r1,'cpu'),mem=ok(r2,'mem'),oom=ok(r3,'oom'),pvc=ok(r4,'pvc'),
        fs=ok(r5,'fs'),edb=ok(r6,'etcd_db'),ertt=ok(r7,'etcd_rtt'),alrt=ok(r8,'alerts');

  const GB=1024**3;
  const result={
    fetchedAt:new Date().toISOString(),durationMs:Date.now()-t0,thanosHost:host,thresholds:T,
    groups:[
      {id:'compute',label:'Compute',icon:'⚡',checks:[
        {id:'cpu_usage',label:'CPU Usage vs Limit',
         description:`Top ${T.topN} pods with CPU usage ≥ ${T.cpuThresholdPct}% of their limit (last 5m)`,
         configKey:'PROM_CPU_THRESHOLD',threshold:T.cpuThresholdPct,unit:'%',
         emptyMsg:`No pods using ≥ ${T.cpuThresholdPct}% of their CPU limit`,
         cols:['Namespace','Pod','CPU Usage %'],colKeys:['namespace','pod','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:cpu.rows,error:cpu.error},
        {id:'memory_usage',label:'Memory Usage vs Limit',
         description:`Top ${T.topN} pods with memory working-set > ${T.memThresholdPct}% of limit`,
         configKey:'PROM_MEM_THRESHOLD',threshold:T.memThresholdPct,unit:'%',
         emptyMsg:`No pods using > ${T.memThresholdPct}% of their memory limit`,
         cols:['Namespace','Pod','Memory Used %'],colKeys:['namespace','pod','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:mem.rows,error:mem.error},
        {id:'oom_killed',label:'OOMKilled Containers',
         description:`Containers OOMKilled in last ${T.oomWindow}`,
         configKey:'PROM_OOM_WINDOW',threshold:T.oomMinCount,unit:'events',
         emptyMsg:`No OOMKill events in the last ${T.oomWindow}`,
         cols:['Namespace','Pod','Container','Kill Count'],colKeys:['namespace','pod','container','valueDisplay'],colWidths:['22%','36%','24%','18%'],
         rows:oom.rows,error:oom.error},
      ]},
      {id:'storage',label:'Storage',icon:'💾',checks:[
        {id:'pvc_usage',label:'PVC Capacity Usage',
         description:`PVCs using > ${T.pvcThresholdPct}% of capacity`,
         configKey:'PROM_PVC_THRESHOLD',threshold:T.pvcThresholdPct,unit:'%',
         emptyMsg:`No PVCs using > ${T.pvcThresholdPct}% of capacity`,
         cols:['Namespace','PVC Name','Used %'],colKeys:['namespace','pvc','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:pvc.rows,error:pvc.error},
        {id:'node_filesystem',label:'Node Filesystem Usage',
         description:`Root filesystem (mountpoint="/") with used% > ${T.fsUsedThreshold}% (excludes ibmc-s3fs, read-only)`,
         configKey:'PROM_FS_USED_THRESHOLD',threshold:T.fsUsedThreshold,unit:'% used',
         emptyMsg:`Root filesystem (/) used% ≤ ${T.fsUsedThreshold}% on all nodes`,
         cols:['Node Instance','Mountpoint','Device','FS Type','Used %'],colKeys:['instance','mountpoint','device','fstype','valueDisplay'],colWidths:['22%','28%','16%','12%','12%'],
         rows:fs.rows,error:fs.error},
      ]},
      {id:'etcd',label:'etcd',icon:'🗃',checks:[
        {id:'etcd_db_size',label:'etcd Database Size',
         description:`etcd DB size — flag if > ${(T.etcdDbBytes/GB).toFixed(0)} GB`,
         configKey:'PROM_ETCD_DB_BYTES',threshold:T.etcdDbBytes,unit:'bytes',
         emptyMsg:'No etcd metrics returned',infoMode:true,
         cols:['etcd Instance','DB Size','Status'],colKeys:['instance','valueDisplay','_status'],colWidths:['60%','25%','15%'],
         rows:edb.rows.map(r=>({...r,_status:r.warn?'⚠ Over limit':'✓ OK'})),error:edb.error},
        {id:'etcd_rtt',label:'etcd Peer RTT (p99)',
         description:`etcd peer RTT p99 (5m) — flag if > ${T.etcdRttMs} ms`,
         configKey:'PROM_ETCD_RTT_MS',threshold:T.etcdRttMs,unit:'ms',
         emptyMsg:'No etcd RTT metrics returned',infoMode:true,
         cols:['etcd Instance','RTT p99','Status'],colKeys:['instance','valueDisplay','_status'],colWidths:['60%','25%','15%'],
         rows:ertt.rows.map(r=>({...r,_status:r.warn?'⚠ High RTT':'✓ OK'})),error:ertt.error},
      ]},
      {id:'alerts',label:'Active Alerts',icon:'🚨',checks:[
        {id:'active_alerts',label:'Firing / Pending Alerts',
         description:`Alerts in firing/pending state, severity: ${T.alertSeverities}`,
         configKey:'PROM_ALERT_SEVERITIES',threshold:0,unit:'count',
         emptyMsg:'✅ No active alerts matching the configured severities',
         cols:['Alert Name','Namespace','Severity','State'],colKeys:['alertname','namespace','severity','valueDisplay'],colWidths:['36%','26%','18%','20%'],
         rows:alrt.rows,error:alrt.error},
      ]},
    ],
  };
  _cache=result; _cacheTime=Date.now();
  const tot=result.groups.reduce((s,g)=>s+g.checks.filter(c=>!c.infoMode).reduce((gs,c)=>gs+c.rows.length,0),0);
  logger.info(`Prometheus: ${tot} violations in ${result.durationMs}ms`);
  return result;
}

function getMockMetrics(){
  const T=getThresholds(); const GB=1024**3;
  return{fetchedAt:new Date().toISOString(),durationMs:387,
    thanosHost:'thanos-querier-openshift-monitoring.apps.mock-cluster.example.com',thresholds:T,
    groups:[
      {id:'compute',label:'Compute',icon:'⚡',checks:[
        {id:'cpu_usage',label:'CPU Usage vs Limit',
         description:`Top ${T.topN} pods with CPU usage ≥ ${T.cpuThresholdPct}% of their limit (last 5m)`,
         configKey:'PROM_CPU_THRESHOLD',threshold:T.cpuThresholdPct,unit:'%',
         emptyMsg:`No pods using ≥ ${T.cpuThresholdPct}% of their CPU limit`,
         cols:['Namespace','Pod','CPU Usage %'],colKeys:['namespace','pod','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:[{namespace:'production',pod:'api-server-7d9f8c6b5-xkzpq',value:97.3,valueDisplay:'97.3%',unit:'%'},
               {namespace:'data-pipeline',pod:'processor-5b8c9d6f4-mnjr4',value:94.1,valueDisplay:'94.1%',unit:'%'},
               {namespace:'ml-training',pod:'trainer-gpu-0',value:91.8,valueDisplay:'91.8%',unit:'%'}],error:null},
        {id:'memory_usage',label:'Memory Usage vs Limit',
         description:`Top ${T.topN} pods with memory working-set > ${T.memThresholdPct}% of limit`,
         configKey:'PROM_MEM_THRESHOLD',threshold:T.memThresholdPct,unit:'%',
         emptyMsg:`No pods using > ${T.memThresholdPct}% of their memory limit`,
         cols:['Namespace','Pod','Memory Used %'],colKeys:['namespace','pod','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:[{namespace:'monitoring',pod:'prometheus-k8s-0',value:88.5,valueDisplay:'88.5%',unit:'%'},
               {namespace:'logging',pod:'elasticsearch-0',value:85.2,valueDisplay:'85.2%',unit:'%'},
               {namespace:'production',pod:'cache-redis-6c8f7b9d5-xyz',value:82.1,valueDisplay:'82.1%',unit:'%'}],error:null},
        {id:'oom_killed',label:'OOMKilled Containers',
         description:`Containers OOMKilled in last ${T.oomWindow}`,
         configKey:'PROM_OOM_WINDOW',threshold:T.oomMinCount,unit:'events',
         emptyMsg:`No OOMKill events in the last ${T.oomWindow}`,
         cols:['Namespace','Pod','Container','Kill Count'],colKeys:['namespace','pod','container','valueDisplay'],colWidths:['22%','36%','24%','18%'],
         rows:[{namespace:'staging',pod:'worker-7d4b9f-abc12',container:'worker',value:3,valueDisplay:'3',unit:'kills'}],error:null},
      ]},
      {id:'storage',label:'Storage',icon:'💾',checks:[
        {id:'pvc_usage',label:'PVC Capacity Usage',
         description:`PVCs using > ${T.pvcThresholdPct}% of capacity`,
         configKey:'PROM_PVC_THRESHOLD',threshold:T.pvcThresholdPct,unit:'%',
         emptyMsg:`No PVCs using > ${T.pvcThresholdPct}% of capacity`,
         cols:['Namespace','PVC Name','Used %'],colKeys:['namespace','pvc','valueDisplay'],colWidths:['28%','52%','20%'],
         rows:[{namespace:'monitoring',pvc:'prometheus-k8s-db-0',value:84.3,valueDisplay:'84.3%',unit:'%'},
               {namespace:'logging',pvc:'elasticsearch-data-0',value:77.6,valueDisplay:'77.6%',unit:'%'},
               {namespace:'production',pvc:'mysql-data-pvc',value:73.1,valueDisplay:'73.1%',unit:'%'}],error:null},
        {id:'node_filesystem',label:'Node Filesystem Usage',
         description:`Root filesystem (mountpoint="/") with used% > ${T.fsUsedThreshold}% (excludes ibmc-s3fs, read-only)`,
         configKey:'PROM_FS_USED_THRESHOLD',threshold:T.fsUsedThreshold,unit:'% used',
         emptyMsg:`Root filesystem (/) used% ≤ ${T.fsUsedThreshold}% on all nodes`,
         cols:['Node Instance','Mountpoint','Device','FS Type','Used %'],colKeys:['instance','mountpoint','device','fstype','valueDisplay'],colWidths:['22%','28%','16%','12%','12%'],
         rows:[{instance:'worker-2:9100',mountpoint:'/',device:'/dev/sda1',fstype:'xfs',freePct:6.6,value:93.4,valueDisplay:'93.4%',unit:'% used'},
               {instance:'worker-5:9100',mountpoint:'/',device:'/dev/sda1',fstype:'xfs',freePct:8.1,value:91.9,valueDisplay:'91.9%',unit:'% used'}],error:null},
      ]},
      {id:'etcd',label:'etcd',icon:'🗃',checks:[
        {id:'etcd_db_size',label:'etcd Database Size',
         description:`etcd DB size — flag if > ${(T.etcdDbBytes/GB).toFixed(0)} GB`,
         configKey:'PROM_ETCD_DB_BYTES',threshold:T.etcdDbBytes,unit:'bytes',
         emptyMsg:'No etcd metrics returned',infoMode:true,
         cols:['etcd Instance','DB Size','Status'],colKeys:['instance','valueDisplay','_status'],colWidths:['60%','25%','15%'],
         rows:[{instance:'etcd-master-0:2379',value:2.10*GB,valueDisplay:'2.10 GB',warn:false,_status:'✓ OK'},
               {instance:'etcd-master-1:2379',value:2.09*GB,valueDisplay:'2.09 GB',warn:false,_status:'✓ OK'},
               {instance:'etcd-master-2:2379',value:2.11*GB,valueDisplay:'2.11 GB',warn:false,_status:'✓ OK'}],error:null},
        {id:'etcd_rtt',label:'etcd Peer RTT (p99)',
         description:`etcd peer RTT p99 (5m) — flag if > ${T.etcdRttMs} ms`,
         configKey:'PROM_ETCD_RTT_MS',threshold:T.etcdRttMs,unit:'ms',
         emptyMsg:'No etcd RTT metrics returned',infoMode:true,
         cols:['etcd Instance','RTT p99','Status'],colKeys:['instance','valueDisplay','_status'],colWidths:['60%','25%','15%'],
         rows:[{instance:'etcd-master-0:2379',value:8.4,valueDisplay:'8.40 ms',warn:false,_status:'✓ OK'},
               {instance:'etcd-master-1:2379',value:12.1,valueDisplay:'12.10 ms',warn:false,_status:'✓ OK'},
               {instance:'etcd-master-2:2379',value:9.7,valueDisplay:'9.70 ms',warn:false,_status:'✓ OK'}],error:null},
      ]},
      {id:'alerts',label:'Active Alerts',icon:'🚨',checks:[
        {id:'active_alerts',label:'Firing / Pending Alerts',
         description:`Alerts in firing/pending state, severity: ${T.alertSeverities}`,
         configKey:'PROM_ALERT_SEVERITIES',threshold:0,unit:'count',
         emptyMsg:'✅ No active alerts matching the configured severities',
         cols:['Alert Name','Namespace','Severity','State'],colKeys:['alertname','namespace','severity','valueDisplay'],colWidths:['36%','26%','18%','20%'],
         rows:[{alertname:'KubePodCrashLooping',namespace:'production',severity:'critical',state:'firing',value:1,valueDisplay:'firing',crit:true,warn:false},
               {alertname:'PrometheusOperatorListErrors',namespace:'monitoring',severity:'warning',state:'pending',value:1,valueDisplay:'pending',crit:false,warn:true}],error:null},
      ]},
    ]};
}

module.exports = { getAllMetrics, getMockMetrics };
