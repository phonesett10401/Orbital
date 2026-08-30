"""Request-scoped access to the ingestion layer.

The store and poller are created once at startup and hung off ``app.state``.
These helpers are the only sanctioned way for a route to reach them, so the
dependency direction stays one-way: the API reads ingestion, ingestion never
imports the API.
"""

from __future__ import annotations

from fastapi import Request

from app.config import Settings
from app.ingestion.flights import FlightHistory
from app.ingestion.flightroutes import FlightRoutes
from app.ingestion.poller import Poller
from app.ingestion.store import ObjectStore


def get_store(request: Request) -> ObjectStore:
    return request.app.state.store


def get_poller(request: Request) -> Poller:
    return request.app.state.poller


def get_flights(request: Request) -> FlightHistory:
    return request.app.state.flights


def get_routes(request: Request) -> FlightRoutes:
    return request.app.state.routes


def get_settings_dep(request: Request) -> Settings:
    return request.app.state.settings
