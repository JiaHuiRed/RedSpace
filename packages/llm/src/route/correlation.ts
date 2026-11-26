import type { HttpClientRequest, HttpClientResponse } from "effect/http"

// 261126 Red Local-only association between one outbound HTTP attempt and the
// request id owned by the caller's recorder. The id rides on the in-memory
// request object only: it never enters the JSON body, headers, query, or any
// provider field, and it is never serialized.
export const REQUEST_CORRELATION: unique symbol = Symbol.for("redcode.llm.request-correlation")

/**
 * Attach the caller-owned request id to the exact `HttpClientRequest` instance
 * that is about to be executed. Call this from the transport owner after the
 * response for this attempt has been acquired, so a retried attempt overwrites
 * the previous id on the same request object.
 */
export const correlateRequest = (request: HttpClientRequest.HttpClientRequest, requestID: string): void => {
  ;(request as CorrelatedRequest)[REQUEST_CORRELATION] = requestID
}

/**
 * Read back the request id attached by {@link correlateRequest}. Responses that
 * were not produced by a correlating transport (WebSocket, tests, other HTTP
 * clients) return `undefined` and are reported as unlinked.
 */
export const correlatedRequestID = (response: HttpClientResponse.HttpClientResponse): string | undefined => {
  const value = (response.request as CorrelatedRequest)[REQUEST_CORRELATION]
  return typeof value === "string" ? value : undefined
}

type CorrelatedRequest = { [REQUEST_CORRELATION]?: string }

export * as RequestCorrelation from "./correlation"
