import { PROVIDER_INFO, type IntegrationProvider } from '@bmu/shared';
import { googleConnector, googleLogin } from './google.js';
import { linkedinConnector, linkedinLogin } from './linkedin.js';
import { metaConnector, metaLogin } from './meta.js';
import { testConnector } from './test.js';
import type { Connector, LoginFlow } from './types.js';

export * from './types.js';

const LOGINS: Record<'meta' | 'linkedin' | 'google', LoginFlow> = { meta: metaLogin, linkedin: linkedinLogin, google: googleLogin };
const CONNECTORS: Record<'meta' | 'linkedin' | 'google', Connector> = { meta: metaConnector, linkedin: linkedinConnector, google: googleConnector };

export const loginFor = (p: IntegrationProvider) => LOGINS[PROVIDER_INFO[p].login];
export const connectorFor = (p: IntegrationProvider, mode: string): Connector => (mode === 'test' ? testConnector : CONNECTORS[PROVIDER_INFO[p].login]);
/** Env vars missing for a provider's "Connect" button. */
export const missingEnv = (p: IntegrationProvider) => PROVIDER_INFO[p].env.filter((k) => !process.env[k]);
