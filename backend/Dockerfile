# Orbital's backend, as a container.
#
# Built for a platform that runs a persistent process - Northflank, Fly, a VM -
# and not for anything serverless. The reason is in `app/main.py`: this holds a
# WebSocket open to aisstream, polls on a schedule, and answers every request
# from memory. A per-request runtime has nowhere to keep any of that.

# 3.12, not 3.14, although the machine this was written on runs 3.14 and
# `pyproject.toml` only asks for >=3.11.
#
# `sgp4` is a C extension. On 3.12 it installs from a prebuilt manylinux wheel;
# on a version too new for one it falls back to compiling from source, which
# needs a toolchain this image deliberately does not carry. Pinning to a
# version with wheels keeps the image small and the build fast.
FROM python:3.12-slim AS base

# Bytecode is written at build time instead of on every cold start, and stdout
# is unbuffered so the platform's log viewer shows a line when it happens
# rather than when the buffer fills.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /srv

# Dependencies before source, so editing a Python file does not re-resolve and
# re-download every package. `pyproject.toml` alone is enough to install them.
COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY app ./app

# A home for the accounts database.
#
# **This is the one piece of state that must outlive the process.** Everything
# else - aircraft, ships, satellites - is rebuilt from upstream within minutes
# of a restart, but an account is gone for good. Mount a volume here, or point
# `ORBITAL_ACCOUNTS_DB_PATH` at one, or accept that sign-ups do not survive a
# redeploy.
RUN mkdir -p /srv/data
ENV ORBITAL_ACCOUNTS_DB_PATH=/srv/data/accounts.db

# Not root. Nothing here needs it, and a container that runs as root is one
# escaped process away from being a problem.
RUN useradd --create-home --uid 10001 orbital && chown -R orbital:orbital /srv
USER orbital

# The platform tells us the port; 8000 is only the fallback for `docker run`
# with nothing set.
ENV PORT=8000
EXPOSE 8000

# **One worker, and this is not a default to tune later.**
#
# Uvicorn's `--workers N` forks N processes that share nothing. Each would open
# its own AIS socket, run its own poller and keep its own store - so the
# OpenSky bill would multiply by N against a fixed daily allowance already
# budgeted at 77%, adsb.lol would rate-limit us within seconds, and two
# requests from the same reader could disagree about where an aircraft is.
#
# Scale this by making the box bigger, never by adding workers.
#
# `--host 0.0.0.0` because the default binds loopback, which inside a container
# means nothing outside it can connect - the commonest way a working image
# looks broken.
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
