# Deploys the Deleverager contract to Base, paid for by the keeper wallet, and saves its address in .env.
# Does NOT authorize it: nothing can touch the position until the owner signs setAuthorization.
#   powershell -ExecutionPolicy Bypass -File scripts\windows\deploy.ps1
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
Set-Location $Root
Import-DotEnv
if ($env:DELEVERAGER_ADDRESS) { Write-Host "Already deployed: $env:DELEVERAGER_ADDRESS (remove DELEVERAGER_ADDRESS from .env to redeploy)"; exit 0 }
if (-not $env:KEEPER_PRIVATE_KEY) { throw "No KEEPER_PRIVATE_KEY in .env. Run: node scripts/new-keeper.js" }

$keeper = node -e "console.log(new (require('ethers').Wallet)(process.env.KEEPER_PRIVATE_KEY).address)"
$bal = node -e "new (require('ethers').JsonRpcProvider)(process.env.BASE_RPC||'https://mainnet.base.org').getBalance('$keeper').then(b=>console.log(b.toString()))"
if ([decimal]$bal -lt [decimal]500000000000000) { throw "Keeper $keeper has $([decimal]$bal / 1e18) ETH on Base. Send about 0.002 ETH first." }

$env:DEPLOYER_PRIVATE_KEY = $env:KEEPER_PRIVATE_KEY
$env:OWNER_ADDRESS = '0x8c62549c7abde21e8ccdb402f4ecf712c14b1c7f'
$env:KEEPER_ADDRESS = $keeper
$net = if ($env:DEPLOY_NETWORK) { $env:DEPLOY_NETWORK } else { 'base' }
$out = npx hardhat run scripts/deploy.js --network $net | Select-Object -Last 1
Remove-Item Env:DEPLOYER_PRIVATE_KEY
$addr = ($out | ConvertFrom-Json).deleverager
if (-not $addr) { throw "Deploy did not return an address: $out" }
$envFile = if ($env:DOTENV) { $env:DOTENV } else { Join-Path $Root '.env' }
Add-Content $envFile "DELEVERAGER_ADDRESS=$addr"
Write-Host "`nDeployed Deleverager: $addr  (saved to .env)"
Write-Host "Next: scripts\windows\install-task.ps1, then authorize it from your owner wallet."
