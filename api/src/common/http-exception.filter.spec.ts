import { ArgumentsHost, NotFoundException } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function hostWith(requestId: string): {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
} {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ requestId }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  it('wraps http exceptions in the envelope with requestId', () => {
    const { host, status, json } = hostWith('req-1');
    new HttpExceptionFilter().catch(
      new NotFoundException('Project not found'),
      host,
    );
    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith({
      error: { status: 404, message: 'Project not found', requestId: 'req-1' },
    });
  });

  it('masks non-http errors as 500 without leaking internals', () => {
    const { host, status, json } = hostWith('req-2');
    new HttpExceptionFilter().catch(new Error('secret db string'), host);
    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: {
        status: 500,
        message: 'Internal server error',
        requestId: 'req-2',
      },
    });
  });

  it('joins array validation messages', () => {
    const { host, json } = hostWith('req-3');
    const exception = new NotFoundException({
      message: ['name must be a string', 'slug is invalid'],
    });
    new HttpExceptionFilter().catch(exception, host);
    expect(json).toHaveBeenCalledWith({
      error: {
        status: 404,
        message: 'name must be a string; slug is invalid',
        requestId: 'req-3',
      },
    });
  });
});
