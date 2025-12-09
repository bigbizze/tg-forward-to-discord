/**
 * Result Type Package
 * 
 * Provides a type-safe way to handle operations that can fail without throwing exceptions.
 * Inspired by Rust's Result<T, E> type, this ensures errors are handled explicitly
 * rather than bubbling up as uncaught exceptions that crash the process.
 * 
 * Philosophy:
 * - Functions that can fail return Result<T, E> instead of throwing
 * - Callers must explicitly handle both success and error cases
 * - Errors are values, not exceptional control flow
 * - This makes error handling explicit and prevents accidental crashes
 */

/**
 * Represents a successful result containing a value of type T.
 * The discriminant `ok: true` allows TypeScript to narrow the type.
 */
export interface Ok<T> {
  readonly ok: true;
  readonly value: T;
  readonly error?: never;
}

/**
 * Represents a failed result containing an error of type E.
 * The discriminant `ok: false` allows TypeScript to narrow the type.
 */
export interface Err<E> {
  readonly ok: false;
  readonly error: E;
  readonly value?: never;
}

/**
 * A Result is either Ok (success with value) or Err (failure with error).
 * This union type forces callers to check `ok` before accessing value/error.
 */
export type Result<T, E> = Ok<T> | Err<E>;

/**
 * Creates a successful Result containing the given value.
 * 
 * @example
 * const result = ok(42);
 * if (result.ok) {
 *   console.log(result.value); // 42
 * }
 */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/**
 * Creates a failed Result containing the given error.
 * 
 * @example
 * const result = err({ code: "NOT_FOUND", message: "User not found" });
 * if (!result.ok) {
 *   console.log(result.error.message); // "User not found"
 * }
 */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/**
 * Standard application error structure used throughout the project.
 * Provides consistent error information for logging and debugging.
 */
export interface AppError {
  /** Machine-readable error code for categorization */
  code: string;
  /** Human-readable error message */
  message: string;
  /** ISO 8601 timestamp when the error occurred */
  timestamp: string;
  /** Optional additional context about the error */
  details?: Record<string, unknown>;
  /** Stack trace if available */
  stackTrace?: string;
}

/**
 * Creates an AppError with the current timestamp.
 * Convenience function to ensure consistent error structure.
 * 
 * @param code - Machine-readable error code
 * @param message - Human-readable description
 * @param details - Optional additional context
 */
export function createAppError(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AppError {
  return {
    code,
    message,
    timestamp: new Date().toISOString(),
    details
  };
}

/**
 * Creates an AppError from a caught exception.
 * Extracts useful information from the error object.
 * 
 * @param error - The caught error (could be anything in JS)
 * @param code - Machine-readable error code to assign
 * @param contextMessage - Optional message to prepend for context
 */
export function appErrorFromException(
  error: unknown,
  code: string,
  contextMessage?: string
): AppError {
  const message = error instanceof Error 
    ? error.message 
    : String(error);
  
  const stackTrace = error instanceof Error 
    ? error.stack 
    : undefined;

  return {
    code,
    message: contextMessage ? `${contextMessage}: ${message}` : message,
    timestamp: new Date().toISOString(),
    stackTrace,
    details: error instanceof Error ? { name: error.name } : undefined
  };
}

/**
 * Wraps a synchronous function that might throw into a Result-returning function.
 * Use this to safely call third-party code or legacy functions.
 * 
 * @example
 * const result = trySync(
 *   () => JSON.parse(userInput),
 *   "PARSE_ERROR",
 *   "Failed to parse JSON"
 * );
 */
export function trySync<T>(
  fn: () => T,
  errorCode: string,
  errorMessage?: string
): Result<T, AppError> {
  try {
    return ok(fn());
  } catch (error) {
    return err(appErrorFromException(error, errorCode, errorMessage));
  }
}

/**
 * Wraps an async function that might throw into a Result-returning function.
 * Use this to safely call async third-party code or legacy functions.
 * 
 * @example
 * const result = await tryAsync(
 *   () => fetch(url).then(r => r.json()),
 *   "FETCH_ERROR",
 *   "Failed to fetch data"
 * );
 */
export async function tryAsync<T>(
  fn: () => Promise<T>,
  errorCode: string,
  errorMessage?: string
): Promise<Result<T, AppError>> {
  try {
    const value = await fn();
    return ok(value);
  } catch (error) {
    return err(appErrorFromException(error, errorCode, errorMessage));
  }
}

/**
 * Maps the value inside an Ok result, leaving Err unchanged.
 * Useful for transforming successful values without unwrapping.
 * 
 * @example
 * const numResult = ok(5);
 * const strResult = mapResult(numResult, n => n.toString()); // Ok("5")
 */
export function mapResult<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => U
): Result<U, E> {
  if (result.ok) {
    return ok(fn(result.value));
  }
  return result;
}

/**
 * Maps the error inside an Err result, leaving Ok unchanged.
 * Useful for adding context or transforming errors.
 */
export function mapError<T, E, F>(
  result: Result<T, E>,
  fn: (error: E) => F
): Result<T, F> {
  if (!result.ok) {
    return err(fn(result.error));
  }
  return result;
}

/**
 * Chains Result-returning operations.
 * If the input is Ok, applies fn and returns the new Result.
 * If the input is Err, returns the error unchanged.
 * 
 * @example
 * const result = flatMap(
 *   parseNumber(input),
 *   n => validatePositive(n)
 * );
 */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  if (result.ok) {
    return fn(result.value);
  }
  return result;
}

/**
 * Unwraps a Result, returning the value if Ok or the default if Err.
 * Use when you have a sensible default for error cases.
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  return result.ok ? result.value : defaultValue;
}

/**
 * Combines multiple Results into a single Result containing an array.
 * Returns Ok with all values if all inputs are Ok.
 * Returns the first Err encountered if any input is Err.
 * 
 * @example
 * const results = [ok(1), ok(2), ok(3)];
 * const combined = combineResults(results); // Ok([1, 2, 3])
 */
export function combineResults<T, E>(
  results: Result<T, E>[]
): Result<T[], E> {
  const values: T[] = [];
  
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    values.push(result.value);
  }
  
  return ok(values);
}

/**
 * Type guard to check if a Result is Ok.
 * Useful for filtering arrays of Results.
 */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/**
 * Type guard to check if a Result is Err.
 */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

// Re-export common error codes for consistency across the project
export const ErrorCodes = {
  // Database errors
  DB_CONNECTION_ERROR: "DB_CONNECTION_ERROR",
  DB_QUERY_ERROR: "DB_QUERY_ERROR",
  DB_NOT_FOUND: "DB_NOT_FOUND",
  DB_CONSTRAINT_VIOLATION: "DB_CONSTRAINT_VIOLATION",
  
  // Validation errors
  VALIDATION_ERROR: "VALIDATION_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  
  // External service errors
  TELEGRAM_ERROR: "TELEGRAM_ERROR",
  DISCORD_ERROR: "DISCORD_ERROR",
  DISCORD_RATE_LIMITED: "DISCORD_RATE_LIMITED",
  DISCORD_WEBHOOK_ERROR: "DISCORD_WEBHOOK_ERROR",
  
  // HTTP errors
  HTTP_ERROR: "HTTP_ERROR",
  UNAUTHORIZED: "UNAUTHORIZED",
  NOT_FOUND: "NOT_FOUND",
  
  // Internal errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR"
} as const;

export type ErrorCode = typeof ErrorCodes[keyof typeof ErrorCodes];
