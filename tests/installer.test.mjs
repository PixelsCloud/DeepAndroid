import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
const run=promisify(execFile)
test('Windows installer rejects an older CLI before creating or mutating a profile',{skip:process.platform!=='win32'},async()=>{
  await mkdir('.build/tests',{recursive:true});const root=await mkdtemp(join(process.cwd(),'.build/tests/installer-'))
  const cli=join(root,'old-dsh.cmd'),archive=join(root,'test.tgz'),home=join(root,'harness-home')
  await writeFile(cli,'@echo off\r\necho 0.2.0-rc.2\r\n');await writeFile(archive,'fixture')
  await assert.rejects(run('pwsh.exe',['-NoProfile','-File',join(process.cwd(),'bin/install-profile.ps1'),'-PackagePath',archive,'-Profile','acceptance','-DshPath',cli],{env:{...process.env,DSH_HOME:home},windowsHide:true}),error=>String(error.stderr).includes('HARNESS_VERSION_MISMATCH'))
  await assert.rejects(access(home))
})
