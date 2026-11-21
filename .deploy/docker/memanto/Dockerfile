# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# Memanto server image for the Ever Works `memanto` agent-memory plugin.
#
# Why build our own instead of `moorcheh/memanto` from Docker Hub: at the time
# of writing that image lags PyPI (0.2.3 vs 0.3.0) and does not ship
# `moorcheh-client`, which MEMANTO_BACKEND=on-prem needs. This image installs
# the pinned PyPI release instead (verified on Python 3.15 against the plugin's
# live contract suite).
#
#   docker build -f .deploy/docker/memanto/Dockerfile -t <registry>/memanto:0.3.0 .
#
# Runtime env (see .deploy/k8s/memanto.optional.yaml):
#   MEMANTO_BACKEND      cloud (default, needs MOORCHEH_API_KEY) | on-prem
#   MOORCHEH_API_KEY     Moorcheh Cloud key — ALSO the management credential
#                        the plugin's `apiKey` must match on the cloud backend
#   MEMANTO_SECRET_KEY   JWT signing key; the management credential on-prem.
#                        Set it explicitly — otherwise one is generated into
#                        the data volume on first boot.
#   MOORCHEH_ONPREM_URL  on-prem only, e.g. http://moorcheh:8080
# State (agent registry, sessions, policies) lives under /home/memanto/.memanto
# — mount a volume there and run ONE replica.
# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.15-slim

ARG MEMANTO_VERSION=0.3.0
ARG MOORCHEH_CLIENT_VERSION=0.1.6

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/home/memanto

COPY .deploy/docker/memanto/entrypoint.sh /usr/local/bin/memanto-entrypoint

RUN chmod 0755 /usr/local/bin/memanto-entrypoint \
    && pip install "memanto==${MEMANTO_VERSION}" "moorcheh-client==${MOORCHEH_CLIENT_VERSION}" \
    && useradd --create-home --uid 1001 --user-group memanto \
    && mkdir -p /home/memanto/.memanto \
    && chown -R memanto:memanto /home/memanto

USER 1001
WORKDIR /home/memanto
EXPOSE 8000

# /ready never calls Moorcheh (no credits spent, no false negatives).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=4).status == 200 else 1)"

# Refuses unrendered placeholder or weak credentials, then runs uvicorn.
ENTRYPOINT ["/usr/local/bin/memanto-entrypoint"]
