# yak

An agentic workflow engine. *It shaves the yak so you don't.*

Reads a YAML DAG, runs steps (shell commands, pure transforms, coding-agent
invocations, human gates), and journals everything to disk so runs resume
exactly where they stopped.

Status: M0 in progress (3/6 — repo scaffold, single-step run, multi-step DAG
execution with fan-out). See `spec.md` §14.
