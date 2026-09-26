#!/usr/bin/env bash
# Manual OMP launcher; preview uses Bash builtins only and never starts services.
set -euo pipefail

usage() {
  printf '%s\n' \
    'Uso: scripts/omp-session.sh [--print] [--no-goal] [--] [instrucción ...]' \
    '  --print    Imprime el prompt; no ejecuta OMP ni modifica archivos.' \
    '  --no-goal  Omite /goal set; conserva el bootstrap y sus restricciones.' \
    '  --help     Muestra esta ayuda.' \
    '  --         Trata todos los argumentos siguientes como instrucciones literales.' \
    'Todas las instrucciones se conservan, en orden; no se pasan como flags a OMP.' \
    'OMP_PROFILE: overlay legible (default: <repo>/.omp/profiles/broker-orchestrator.yml).' \
    'Una ruta relativa de OMP_PROFILE se resuelve desde el directorio de invocación.' \
    'Sin --print se abre OMP: requiere revisión previa de modelos exactos y statusline.'
}

fail() {
  printf 'error: %s\n' "$1" >&2
  exit "${2:-1}"
}

PRINT_ONLY=0
WITH_GOAL=1
EXTRAS=()
while (( $# > 0 )); do
  case "$1" in
    --print) PRINT_ONLY=1 ;;
    --no-goal) WITH_GOAL=0 ;;
    --help) usage; exit 0 ;;
    --) shift; EXTRAS+=("$@"); break ;;
    -*) fail "Opción desconocida: $1. Consulte --help; use -- antes de instrucciones que empiecen por '-'." 2 ;;
    *) EXTRAS+=("$1") ;;
  esac
  shift
done

INVOCATION_DIR=$PWD
SCRIPT_PATH=${BASH_SOURCE[0]}
[[ "$SCRIPT_PATH" == */* ]] || SCRIPT_PATH="./$SCRIPT_PATH"
CDPATH='' builtin cd -P -- "${SCRIPT_PATH%/*}/.." >/dev/null || fail 'No se pudo resolver la raíz del proyecto desde el script.'
REPO_ROOT=$PWD
PROFILE=${OMP_PROFILE:-$REPO_ROOT/.omp/profiles/broker-orchestrator.yml}
[[ "$PROFILE" == /* ]] || PROFILE="$INVOCATION_DIR/$PROFILE"
BOOTSTRAP_FILE="$REPO_ROOT/prompts/omp-session-bootstrap.md"
GOAL_FILE="$REPO_ROOT/prompts/goal-objective.txt"

[[ -f "$BOOTSTRAP_FILE" && -r "$BOOTSTRAP_FILE" ]] || fail "Bootstrap ausente o no legible: $BOOTSTRAP_FILE"
BOOTSTRAP=''
IFS= read -r -d '' BOOTSTRAP < "$BOOTSTRAP_FILE" || [[ -n "$BOOTSTRAP" ]] || fail "Bootstrap vacío: $BOOTSTRAP_FILE"
PROMPT=$BOOTSTRAP

if (( WITH_GOAL )); then
  [[ -f "$GOAL_FILE" && -r "$GOAL_FILE" ]] || fail "Objetivo ausente o no legible: $GOAL_FILE"
  GOAL_LINES=()
  mapfile -t GOAL_LINES < "$GOAL_FILE"
  (( ${#GOAL_LINES[@]} == 1 )) || fail "El objetivo debe contener exactamente una línea, sin líneas vacías adicionales: $GOAL_FILE"
  GOAL_OBJECTIVE=${GOAL_LINES[0]}
  [[ "$GOAL_OBJECTIVE" != *$'\r'* ]] || fail "El objetivo contiene CR; use una sola línea con terminación LF: $GOAL_FILE"
  [[ "$GOAL_OBJECTIVE" == 'orchestrate '* && "${GOAL_OBJECTIVE#orchestrate }" =~ [^[:space:]] ]] || fail "El objetivo debe empezar exactamente por 'orchestrate ' y tener contenido: $GOAL_FILE"
  printf -v PROMPT '/goal set %s\n\n%s' "$GOAL_OBJECTIVE" "$BOOTSTRAP"
fi

printf -v PROMPT '%s\n\n## Contexto efectivo del launcher\nRepo (--cwd): %s\nOverlay efectivo (--config): %s\nOMP_PROFILE es solo el override de este launcher; se elimina del entorno hijo antes de exec para no seleccionar un named profile de OMP. Usa esta ruta, no esa variable, para el preflight.\n' "$PROMPT" "$REPO_ROOT" "$PROFILE"

if (( ${#EXTRAS[@]} > 0 )); then
  printf -v PROMPT '%s\n\n## Instrucciones adicionales del operador\n' "$PROMPT"
  for EXTRA in "${EXTRAS[@]}"; do
    printf -v PROMPT '%s%s\n' "$PROMPT" "$EXTRA"
  done
fi

if [[ ! -f "$PROFILE" || ! -r "$PROFILE" ]]; then
  if (( PRINT_ONLY )); then
    printf 'warning: overlay ausente o no legible: %s. Preview permitido; lanzamiento bloqueado hasta preparar un overlay con IDs exactos verificados.\n' "$PROFILE" >&2
  else
    fail "Overlay ausente o no legible: $PROFILE. Prepare ese archivo con IDs exactos del catálogo activo o indique OMP_PROFILE=/ruta/overlay.yml. No use IDs aproximados; --print funciona sin overlay."
  fi
fi

if (( PRINT_ONLY )); then
  printf 'preview: repo=%s; profile=%s; modelos NO verificados por este script.\n' "$REPO_ROOT" "$PROFILE" >&2
  printf '%s\n' "$PROMPT"
  exit 0
fi

command -v omp >/dev/null 2>&1 || fail 'OMP no está disponible en PATH. Instálelo/configúrelo manualmente antes de lanzar; este script no instala herramientas.' 127
printf 'launch: repo=%s; profile=%s. Preflight de catálogo exacto/statusline obligatorio antes de delegar.\n' "$REPO_ROOT" "$PROFILE" >&2
# OMP itself uses OMP_PROFILE for a named auth/session profile, not an overlay.
unset OMP_PROFILE
exec omp --config "$PROFILE" --cwd "$REPO_ROOT" "$PROMPT"
