import { randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Ticket 07: agent steps need the Anthropic API, so containment here is a
 * network *allowlist*, not `command` steps' `--network none` (ticket 04/05).
 * `api.anthropic.com` is the only domain the `claude-code` CLI itself talks
 * to for a `query()` call — statsig/telemetry endpoints are not included
 * since yak's `bypassPermissions` + fixed `Options` never opts into them. */
export const DEFAULT_ALLOWED_DOMAINS = ['api.anthropic.com']

/** Built from `docker/agent-proxy/` — see that directory's Dockerfile.
 * Not yak-published; built locally (`docker build`) same as the default
 * agent-sandbox image (`docker/agent-sandbox/`). */
const PROXY_IMAGE = 'yak-agent-sandbox-proxy:latest'
const PROXY_PORT = 3128

export interface AgentSandboxNetwork {
  networkName: string
  /** `HTTP_PROXY`/`HTTPS_PROXY` value for the agent container — routes all
   * egress through the allowlisting proxy sidecar on this network. */
  proxyUrl: string
  teardown(): Promise<void>
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex')
}

/** Docker network/container names are restricted to `[a-zA-Z0-9_.-]` —
 * step ids aren't guaranteed to satisfy that, so sanitize rather than
 * trusting the workflow author's id choice. */
export function sandboxNetworkName(stepId: string): string {
  return `yak-agent-${stepId.replace(/[^a-zA-Z0-9_.-]/g, '-')}-${randomSuffix()}`
}

export function proxyContainerName(networkName: string): string {
  return `${networkName}-proxy`
}

/** `--internal`: no default route to the outside world for anything
 * attached to this network — the proxy container is the only member with
 * a second leg onto `bridge` (see `connectProxyToBridgeArgs`), so it's the
 * sole path out. */
export function createNetworkArgs(networkName: string): string[] {
  return ['network', 'create', '--internal', networkName]
}

export function removeNetworkArgs(networkName: string): string[] {
  return ['network', 'rm', networkName]
}

export function startProxyArgs(networkName: string, containerName: string, allowedDomains: string[]): string[] {
  return [
    'run',
    '-d',
    '--rm',
    '--name',
    containerName,
    '--network',
    networkName,
    '-e',
    `ALLOWED_DOMAINS=${allowedDomains.join(',')}`,
    PROXY_IMAGE,
  ]
}

/** The proxy needs its own route to the real internet to reach
 * `api.anthropic.com` — `docker run --network` only accepts one network at
 * creation, so the second leg is attached after start via `network connect`. */
export function connectProxyToBridgeArgs(containerName: string): string[] {
  return ['network', 'connect', 'bridge', containerName]
}

export function removeProxyArgs(containerName: string): string[] {
  return ['rm', '-f', containerName]
}

async function docker(args: string[]): Promise<void> {
  await execFileAsync('docker', args)
}

/**
 * One internal network + squid-proxy sidecar per agent-step invocation,
 * torn down when the step finishes — same per-step (not per-run) lifecycle
 * ticket 05 established for `command` steps' sandbox containers. The agent
 * container itself attaches only to `networkName` and reaches the internet
 * exclusively through `proxyUrl`, which the proxy sidecar's `squid.conf`
 * (generated from `ALLOWED_DOMAINS` at its own container start, see
 * `docker/agent-proxy/entrypoint.sh`) restricts to `allowedDomains`.
 */
export async function createAgentSandboxNetwork(
  stepId: string,
  allowedDomains: string[] = DEFAULT_ALLOWED_DOMAINS,
): Promise<AgentSandboxNetwork> {
  const networkName = sandboxNetworkName(stepId)
  const containerName = proxyContainerName(networkName)

  await docker(createNetworkArgs(networkName))
  try {
    await docker(startProxyArgs(networkName, containerName, allowedDomains))
    await docker(connectProxyToBridgeArgs(containerName))
  } catch (err) {
    await docker(removeNetworkArgs(networkName)).catch(() => {})
    throw err
  }

  return {
    networkName,
    proxyUrl: `http://${containerName}:${PROXY_PORT}`,
    async teardown() {
      await docker(removeProxyArgs(containerName)).catch(() => {})
      await docker(removeNetworkArgs(networkName)).catch(() => {})
    },
  }
}
