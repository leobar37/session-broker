/**
 * `@session-broker/client` — cliente público reutilizable (P-003 / G-001).
 *
 * Superficie pública congelada en `docs/contracts/packages.md`:
 * `createClient`, `BrokerClient`, `ClientOptions`, `Subscription`. Se añaden
 * los errores tipados (`BrokerClientError`) necesarios para distinguir la
 * espera local de la cancelación remota; ver `./errors`.
 *
 * Este paquete solo consume exports públicos de `@session-broker/protocol` y
 * el `WebSocket` global del runtime. Importarlo no conecta ni ejecuta
 * inferencia.
 */

export { createClient, reconnectDelayMs } from "./client";
export type { BrokerClient, ClientOptions, Subscription } from "./client";
export { BrokerClientError, isBrokerClientError } from "./errors";
export type { ClientErrorKind } from "./errors";
