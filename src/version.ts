/**
 * In its own module so transport can stamp `X-Arsel-SDK` without importing the
 * public surface (index → events → transport would be a cycle).
 */
export const SDK_VERSION = '1.4.0';
