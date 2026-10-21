#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { projectDeploymentProfiles } from '../packages/shared/src/deployment-defaults.ts';

const [file, profile, ...extra] = process.argv.slice(2);
if (!file || !profile || extra.length) throw new Error('Usage: project-deployment-defaults <config.json> <profile>');
const input = JSON.parse(readFileSync(file, 'utf8'));
const projected = projectDeploymentProfiles(input, profile);
writeFileSync(file, `${JSON.stringify(projected, null, 2)}\n`);
