import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';

interface ResLike {
  status(code: number): { json(body: unknown): void };
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Http');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<ResLike>();
    const req = ctx.getRequest<{ requestId?: string }>();
    const requestId = req.requestId ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const raw = exception.getResponse();
      const message =
        typeof raw === 'string'
          ? raw
          : ((raw as { message?: string | string[] }).message ??
            exception.message);
      res.status(status).json({
        error: {
          status,
          message: Array.isArray(message) ? message.join('; ') : message,
          requestId,
        },
      });
      return;
    }

    this.logger.error(
      `Unhandled error [${requestId}]`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    res.status(500).json({
      error: { status: 500, message: 'Internal server error', requestId },
    });
  }
}
