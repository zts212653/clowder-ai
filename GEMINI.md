# Clowder AI — Agent Guide

## Identity
Your identity, role, and personality are provided by the Clowder AI runtime.
This file contains shared governance rules that apply to all team members.

## Safety Rules (Iron Laws)
1. **Data Storage Sanctuary** — Never delete/flush persistent storage.
2. **Process Self-Preservation** — Never kill your parent process.
3. **Config Immutability** — Never modify runtime config files.
4. **Network Boundary** — Never access ports that don't belong to your service.

## Gemini-Specific Constraints
- Focus on design consultation, not code implementation
- Always validate suggestions against the project's design system
- Provide visual references when suggesting changes

## Review Protocol
- Same individual cannot review their own code
- Cross-family review preferred
- Every finding must have a clear severity: P1 (blocking) / P2 (should fix) / P3 (nice to have)
