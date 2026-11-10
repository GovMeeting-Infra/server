import { Readable } from 'node:stream';
import { of } from 'rxjs';
import { CsvBodyInterceptor, MAX_CSV_BYTES } from '../csv-body.interceptor';

function request(body: Buffer, headers: Record<string, string>) {
  const req: any = Readable.from([body.subarray(0, 3), body.subarray(3)]);
  req.headers = headers;
  return req;
}

const contextFor = (req: any) =>
  ({ switchToHttp: () => ({ getRequest: () => req }) }) as any;

const next = { handle: jest.fn(() => of('handled')) };

describe('CsvBodyInterceptor', () => {
  const interceptor = new CsvBodyInterceptor();

  it('reads the body into req.csvBody', async () => {
    const req = request(Buffer.from('a,b,c\n1,2,3'), {
      'content-type': 'text/csv; charset=utf-8',
    });
    await interceptor.intercept(contextFor(req), next);
    expect(req.csvBody.toString()).toBe('a,b,c\n1,2,3');
    expect(next.handle).toHaveBeenCalled();
  });

  it.each([
    'text/plain',
    'application/vnd.ms-excel',
    'application/octet-stream',
  ])('accepts %s, which browsers report for a .csv', async (type) => {
    const req = request(Buffer.from('x'), { 'content-type': type });
    await expect(
      interceptor.intercept(contextFor(req), next),
    ).resolves.toBeDefined();
  });

  it('refuses JSON and form posts', async () => {
    for (const type of [
      'application/json',
      'multipart/form-data; boundary=x',
      '',
    ]) {
      const req = request(Buffer.from('{}'), { 'content-type': type });
      await expect(
        interceptor.intercept(contextFor(req), next),
      ).rejects.toMatchObject({
        status: 415,
      });
    }
  });

  it('refuses a declared length over the cap without reading it', async () => {
    const req = request(Buffer.from('x'), {
      'content-type': 'text/csv',
      'content-length': String(MAX_CSV_BYTES + 1),
    });
    await expect(
      interceptor.intercept(contextFor(req), next),
    ).rejects.toMatchObject({
      status: 413,
      response: { code: 'FILE_TOO_LARGE' },
    });
    expect(req.csvBody).toBeUndefined();
  });

  it('refuses a body that streams past the cap with no length declared', async () => {
    const req = request(Buffer.alloc(MAX_CSV_BYTES + 10, 0x61), {
      'content-type': 'text/csv',
    });
    await expect(
      interceptor.intercept(contextFor(req), next),
    ).rejects.toMatchObject({ status: 413 });
  });
});
