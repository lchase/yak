import { describe, expect, it } from 'vitest'
import {
  connectProxyToBridgeArgs,
  createNetworkArgs,
  DEFAULT_ALLOWED_DOMAINS,
  proxyContainerName,
  removeNetworkArgs,
  removeProxyArgs,
  sandboxNetworkName,
  startProxyArgs,
} from '../../src/adapters/sandbox-network.js'

describe('sandboxNetworkName', () => {
  it('sanitizes characters outside [a-zA-Z0-9_.-] from the step id', () => {
    const name = sandboxNetworkName('my step/id!')
    expect(name).toMatch(/^yak-agent-my-step-id--[0-9a-f]{8}$/)
  })

  it('produces a different name on each call (per-invocation, not per-step)', () => {
    expect(sandboxNetworkName('a')).not.toBe(sandboxNetworkName('a'))
  })
})

describe('proxyContainerName', () => {
  it('derives the proxy container name from the network name', () => {
    expect(proxyContainerName('yak-agent-a-1234abcd')).toBe('yak-agent-a-1234abcd-proxy')
  })
})

describe('docker argv builders', () => {
  it('createNetworkArgs builds an --internal network', () => {
    expect(createNetworkArgs('net1')).toEqual(['network', 'create', '--internal', 'net1'])
  })

  it('removeNetworkArgs removes the network', () => {
    expect(removeNetworkArgs('net1')).toEqual(['network', 'rm', 'net1'])
  })

  it('startProxyArgs attaches the proxy to the internal network with an ALLOWED_DOMAINS env var', () => {
    expect(startProxyArgs('net1', 'net1-proxy', ['api.anthropic.com'])).toEqual([
      'run',
      '-d',
      '--rm',
      '--name',
      'net1-proxy',
      '--network',
      'net1',
      '-e',
      'ALLOWED_DOMAINS=api.anthropic.com',
      'yak-agent-sandbox-proxy:latest',
    ])
  })

  it('startProxyArgs joins multiple allowed domains with commas', () => {
    const args = startProxyArgs('net1', 'net1-proxy', ['api.anthropic.com', 'example.com'])
    expect(args).toContain('ALLOWED_DOMAINS=api.anthropic.com,example.com')
  })

  it('connectProxyToBridgeArgs attaches the default bridge network for internet egress', () => {
    expect(connectProxyToBridgeArgs('net1-proxy')).toEqual(['network', 'connect', 'bridge', 'net1-proxy'])
  })

  it('removeProxyArgs force-removes the proxy container', () => {
    expect(removeProxyArgs('net1-proxy')).toEqual(['rm', '-f', 'net1-proxy'])
  })
})

describe('DEFAULT_ALLOWED_DOMAINS', () => {
  it('allows only the Anthropic API by default', () => {
    expect(DEFAULT_ALLOWED_DOMAINS).toEqual(['api.anthropic.com'])
  })
})
