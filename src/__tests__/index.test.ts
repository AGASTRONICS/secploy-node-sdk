import { Secploy } from '../index';

describe('Secploy', () => {
  const config = {
    apiKey: 'test-api-key',
    environmentKey: 'test-env',
    organizationId: 'test-org',
    ingestUrl: 'https://ingest.secploy.com'
  };

  it('should create an instance with provided config', () => {
    const client = new Secploy(config);
    expect(client).toBeInstanceOf(Secploy);
  });

  it('should have required methods', () => {
    const client = new Secploy(config);
    expect(typeof client.trackEvent).toBe('function');
    expect(typeof client.recordSecurityEvent).toBe('function');
    expect(typeof client.recordMetric).toBe('function');
    expect(typeof client.recordAuditLog).toBe('function');
  });
});
