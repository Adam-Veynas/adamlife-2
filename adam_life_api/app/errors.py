import logging
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from starlette.exceptions import HTTPException
from starlette.middleware.cors import CORSMiddleware

logger = logging.getLogger("adamlife.api")


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[dict[str, Any]] = Field(default_factory=list)
    request_id: str


class ErrorResponse(BaseModel):
    error: ErrorBody


class APIError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message


class JSONCORSMiddleware(CORSMiddleware):
    def preflight_response(self, request_headers):
        response = super().preflight_response(request_headers)
        if response.status_code < 400:
            return response
        request_id = str(uuid4())
        headers = dict(response.headers)
        headers.pop("content-length", None)
        headers.pop("content-type", None)
        return JSONResponse(status_code=400,
                            content=ErrorResponse(error=ErrorBody(
                                code="CORS_REJECTED", message="Cross-origin request not permitted",
                                request_id=request_id,
                            )).model_dump(), headers={**headers, "X-Request-ID": request_id})


def error_response(request: Request, status: int, code: str, message: str,
                   details: list[dict[str, Any]] | None = None,
                   headers: dict[str, str] | None = None) -> JSONResponse:
    request_id = getattr(request.state, "request_id", None) or str(uuid4())
    return JSONResponse(
        status_code=status,
        content=ErrorResponse(error=ErrorBody(
            code=code, message=message, details=details or [], request_id=request_id,
        )).model_dump(),
        headers={**(headers or {}), "X-Request-ID": request_id},
    )


def register_errors(app: FastAPI) -> None:
    @app.exception_handler(APIError)
    async def application_error(request: Request, exc: APIError) -> JSONResponse:
        return error_response(request, exc.status, exc.code, exc.message)

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException) -> JSONResponse:
        messages = {404: "Endpoint not found", 405: "Method not allowed"}
        return error_response(request, exc.status_code, f"HTTP_{exc.status_code}",
                              messages.get(exc.status_code, "Request could not be completed"),
                              headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Do not echo the user's input, body, or exception context (possible secrets/PII).
        details = [{"location": list(item["loc"]), "type": item["type"]} for item in exc.errors()]
        return error_response(request, 422, "VALIDATION_ERROR", "Invalid request", details)

    @app.exception_handler(SQLAlchemyError)
    async def database_error(request: Request, exc: SQLAlchemyError) -> JSONResponse:
        logger.error("database_failure request_id=%s type=%s", request.state.request_id, type(exc).__name__)
        return error_response(request, 503, "DATABASE_UNAVAILABLE", "Database temporarily unavailable")

    @app.exception_handler(IntegrityError)
    async def constraint_error(request: Request, exc: IntegrityError) -> JSONResponse:
        return error_response(request, 409, "DATA_CONFLICT", "Request conflicts with data constraints")
