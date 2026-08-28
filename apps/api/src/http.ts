import { randomUUID } from 'node:crypto';
import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
  type INestApplication,
} from '@nestjs/common';
import helmet from 'helmet';
@Catch()
class SafeExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const status = error instanceof HttpException ? error.getStatus() : 500;
    const response = host.switchToHttp().getResponse();
    response.status(status).json({
      code:
        status === 404
          ? 'NOT_FOUND'
          : status === 503
            ? 'SERVICE_UNAVAILABLE'
            : 'REQUEST_FAILED',
      message:
        status === 404
          ? 'Resource not found'
          : status === 503
            ? 'Service is not ready'
            : 'Request could not be completed',
      requestId: response.getHeader('x-request-id'),
    });
  }
}
export function configureHttp(app: INestApplication): void {
  app.setGlobalPrefix('/api/v1');
  app.use(helmet());
  app.use(
    (
      _request: unknown,
      response: { setHeader: (key: string, value: string) => void },
      next: () => void,
    ) => {
      response.setHeader('x-request-id', randomUUID());
      response.setHeader('cache-control', 'no-store');
      next();
    },
  );
  app.useGlobalFilters(new SafeExceptionFilter());
}
