import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports database down when the query fails', async () => {
    const prisma = { $queryRaw: () => Promise.reject(new Error('no db')) };
    const res = await new HealthController(prisma as never).check();
    expect(res.status).toBe('ok');
    expect(res.database).toBe('down');
  });
});
