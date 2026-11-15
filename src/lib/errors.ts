export class HttpError extends Error {
  status: number
  code: string
  details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export const badRequest = (msg = 'Invalid request', details?: unknown) => new HttpError(400, 'bad_request', msg, details)
export const unauthorized = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg)
export const forbidden = (msg = 'You do not have permission to do that') => new HttpError(403, 'forbidden', msg)
export const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg)
export const conflict = (msg = 'Conflict') => new HttpError(409, 'conflict', msg)
export const tooMany = (msg = 'Too many requests, please try again later') => new HttpError(429, 'rate_limited', msg)
