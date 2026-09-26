# Identidad y rutas (FR-001 / FR-002 / FR-003)

Fuente ejecutable: `packages/protocol/src/ids.ts`, `packages/protocol/src/identity.ts`.

## Dominios de identidad (nunca intercambiables)

| Identificador | Ámbito | Ciclo de vida | Formato congelado |
| --- | --- | --- | --- |
| `projectId` | Proyecto lógico | Estable; compartido por clones/worktrees | `^prj_[0-9a-f]{32}$` |
| `workspaceId` | Checkout local | Único por checkout; NO viaja en clones | `^wsp_[0-9a-f]{32}$` |
| `nativeSessionId` | Sesión nativa persistible (OMP) | Vive/desaparece con la sesión nativa | opaca, `^[A-Za-z0-9._:@/+-]{1,128}$` sin prefijos reservados |
| `sessionRef` | Referencia broker con ámbito explícito | Derivada; ver abajo | objeto validado |
| `instanceId` | Proceso | Cambia en cada proceso | `^ins_[0-9a-f]{32}$` |
| `connectionId` | Conexión WS | Por conexión | `^con_[0-9a-f]{32}$` |
| `requestId` | Solicitud | Elegido por el cliente; único por proyecto | `^req_[0-9a-f]{32}$` |
| `eventId` | Evento | Por evento | `^evt_[0-9a-f]{32}$` |
| `eventSeq` | Stream de eventos | Entero ≥ 1, estrictamente creciente | entero seguro |
| `controlEpoch` | Lease de control | Entero ≥ 0; 0 = sin lease | entero seguro |
| `grantId` | Grant autenticado | Hasta expiración/revocación | `^grt_[0-9a-f]{32}$` |

`nativeSessionId` es **opaca por diseño**: el protocolo no interpreta su
contenido ni asume el formato de OMP; solo acota charset/longitud para evitar
abusos de parsing.

## Namespaces disjuntos (validadores disjuntos por construcción)

Los prefijos `prj_`, `wsp_`, `ins_`, `con_`, `req_`, `evt_`, `grt_`, `rp_` y
`chal_` están **reservados** a sus namespaces y a nada más. Reglas congeladas
(`packages/protocol/src/ids.ts`, `RESERVED_ID_PREFIXES`):

- Los validadores tipados (`isProjectId`, `isWorkspaceId`, `isInstanceId`,
  `isConnectionId`, `isRequestId`, `isEventId`, `isGrantId`) solo aceptan su
  propio prefijo + 32 hex: son disjuntos entre sí.
- `isNativeSessionId` y `isTargetId` **rechazan** cualquier valor que empiece
  por un prefijo reservado (aunque el resto no sea hex): un `prj_…`, `req_…`,
  etc. jamás es una sesión nativa ni un target. Cualquier otro valor opaco
  válido conserva su formato (sin interpretar contenido).
- `target` y `nativeSessionId` son identificadores de nombre/contenido opaco
  **sin prefijo reservado** y se distinguen por campo (`target.target` vs
  `sessionRef.nativeSessionId`), no por patrón: restringirlos más haría
  inválidos IDs nativos legítimos cuyo formato OMP no está definido
  (unknown documentado en la matriz de compatibilidad).

## `sessionRef` — ámbito explícito

```ts
interface SessionRef {
  projectId: ProjectId;
  scope: "project" | "workspace";
  workspaceId?: WorkspaceId;      // obligatorio ⇔ scope === "workspace"
  target: TargetId;               // ^[a-z][a-z0-9._-]{0,62}$
  nativeSessionId: NativeSessionId;
}
```

Validación congelada (`validateSessionRef`):
- `workspaceId` presente con `scope: "project"` → `INVALID_INPUT/invalid_field`.
- `workspaceId` ausente con `scope: "workspace"` → `INVALID_INPUT/invalid_field`.
- Campos desconocidos → `INVALID_INPUT/unknown_fields`.

## Archivos de identidad y rutas

| Archivo | Versionado | Contenido | Esquema |
| --- | --- | --- | --- |
| `.broker/project.json` | SÍ (Git) | `projectId`, `createdAtMs`, `name?` | `schemaVersion: 1` |
| `.broker/workspace.json` | NO (gitignored) | `workspaceId`, `projectId`, `rootPath`, `createdAtMs` | `schemaVersion: 1` |

- `PROJECT_FILE_SCHEMA_VERSION = 1`, `WORKSPACE_FILE_SCHEMA_VERSION = 1`.
- Cualquier `schemaVersion` distinto (formato futuro) →
  `INVALID_INPUT/unsupported_schema_version` (fail-closed, sin migración difusa).
- Campos desconocidos dentro de v1 → `INVALID_INPUT/unknown_fields`.
- **Permisos/redacción:** `.broker/workspace.json` es local y debe vivir con
  permisos restrictivos (`0600` objetivo); ni él ni `project.json` contienen
  secretos. Endpoints y credenciales viven SOLO en configuración de usuario
  (fuera de worktrees, jamás versionados). DB, journals y backups viven en
  user data (fuera de worktrees).

## Clone/move/copia: detección y regeneración explícita

`workspace.json` registra `rootPath` (raíz absoluta del checkout al emitirse) y
la comparación es igualdad exacta tras `normalizeRootPath` (recorte de `/`
finales):

- raíz actual == `rootPath` → identidad válida.
- raíz actual != `rootPath` → **`INVALID_INPUT/workspace_identity_mismatch`**:
  el archivo fue copiado/movido/clonado y NO acredita este checkout. El
  consumidor (CLI P-003) debe exigir **regeneración explícita** del
  `workspaceId` (flag dedicado) que:
  1. genera un `workspaceId` nuevo,
  2. archiva el archivo previo (p. ej. `workspace.json.conflict-<ts>`),
  3. nunca sobrescribe en silencio ni conserva la identidad ajena.

Un clon limpio (sin `.broker/workspace.json`) simplemente genera su propio
`workspaceId`; conserva `projectId` porque `project.json` sí viaja en Git.

## Precedencia de identidad (fijada)

1. Identidad autenticada de la conexión (grant + credencial verificada).
2. `sessionRef` explícito en la solicitud (validado contra el grant).
3. `instanceId` vigente del proceso (verificado por root proof en bootstrap).
4. IDs declarados en archivos locales — solo selectores; **nunca** credenciales.

## Separación de vidas (resumen operativo)

- Reconnect del mismo proceso conserva `instanceId`; reiniciar crea otro.
- Reanudar una sesión nativa verificada puede conservar el `sessionRef`.
- Cambiar de sesión/branch invalida el binding anterior (nuevo `sessionRef`).
- Copias de historial, alias, PID, cwd o pane no prueban identidad.
