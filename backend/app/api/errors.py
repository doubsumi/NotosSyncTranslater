"""JSON error model shared by the API.

Every failure is returned as ``{"error": {"code": ..., "message": ..., ...}}``
so the frontend can surface it in a toast popup instead of inline text.
"""
from __future__ import annotations

from typing import Any

from flask import current_app, jsonify, request
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge


class ApiError(Exception):
    """An error that maps directly to a JSON API response."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        details: dict[str, Any] | None = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def register_error_handlers(app) -> None:  # noqa: ANN001
    @app.errorhandler(ApiError)
    def _api_error(err: ApiError):
        return (
            jsonify(
                {
                    "error": {
                        "code": err.code,
                        "message": err.message,
                        **err.details,
                    }
                }
            ),
            err.status,
        )

    @app.errorhandler(RequestEntityTooLarge)
    def _too_large(_err):  # noqa: ANN001
        return (
            jsonify(
                {
                    "error": {
                        "code": "PAYLOAD_TOO_LARGE",
                        "message": "request body is too large",
                    }
                }
            ),
            413,
        )

    @app.errorhandler(HTTPException)
    def _http_error(err: HTTPException):  # noqa: ANN001
        if request.path.startswith("/api/"):
            return (
                jsonify(
                    {
                        "error": {
                            "code": err.name.upper().replace(" ", "_"),
                            "message": err.description or err.name,
                        }
                    }
                ),
                err.code,
            )
        return err

    @app.errorhandler(Exception)
    def _unhandled(err: Exception):  # noqa: ANN001
        current_app.logger.exception("unhandled error: %s", err)
        return (
            jsonify(
                {
                    "error": {
                        "code": "INTERNAL",
                        "message": "internal server error",
                    }
                }
            ),
            500,
        )
