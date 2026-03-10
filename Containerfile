# =============================================================================
# Stage 1 — Builder  (native arm64 for npm, no oc execution)
# =============================================================================
FROM registry.access.redhat.com/ubi9/nodejs-18:latest AS builder

USER root
WORKDIR /build

# ── Download the Linux/amd64 oc binary as a plain file (never executed) ───────
ARG OC_VERSION=4.14.0
RUN curl -fsSL \
      "https://mirror.openshift.com/pub/openshift-v4/clients/ocp/${OC_VERSION}/openshift-client-linux.tar.gz" \
      -o /tmp/oc.tar.gz && \
    tar -xzf /tmp/oc.tar.gz -C /tmp oc && \
    rm -f /tmp/oc.tar.gz && \
    chmod +x /tmp/oc && \
    ls -lh /tmp/oc && \
    echo "oc downloaded OK"

# ── Node dependencies ─────────────────────────────────────────────────────────
# Use npm install (not ci) so package-lock.json is not required
COPY package.json ./
RUN npm install --ignore-scripts --production && \
    echo "npm install complete"

# ── Application source ────────────────────────────────────────────────────────
COPY src/     ./src/
COPY config/  ./config/
COPY public/  ./public/

# =============================================================================
# Stage 2 — Runtime (linux/amd64 for OpenShift)
# =============================================================================
FROM --platform=linux/amd64 registry.access.redhat.com/ubi9/nodejs-18-minimal:latest AS runtime

USER root
WORKDIR /app

# ── Copy oc binary ────────────────────────────────────────────────────────────
COPY --from=builder /tmp/oc /usr/local/bin/oc

# ── Copy app ──────────────────────────────────────────────────────────────────
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/src          ./src
COPY --from=builder /build/config       ./config
COPY --from=builder /build/public       ./public
COPY --from=builder /build/package.json ./package.json

# ── Permissions ───────────────────────────────────────────────────────────────
RUN mkdir -p /artifacts && \
    chown -R 1001:0 /app /artifacts && \
    chmod -R g=u /app /artifacts

USER 1001

ENV PORT=8080 \
    ARTIFACT_BASE_DIR=/artifacts \
    OC_BIN=/usr/local/bin/oc \
    LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://localhost:8080/healthz || exit 1

VOLUME ["/artifacts"]

CMD ["node", "src/server.js"]
