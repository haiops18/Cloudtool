Copy the entire windows-debug-steps directory to the VM, for example C:\CloudToolDebug.
Open Windows PowerShell 5.1 as Administrator in 64-bit mode. Run files separately.
Do not use Cloudbase-Init for steps 02-05: these files need their sibling helper/config files.
Only 01-bootstrap.ps1 is independent and can also be pasted into user-data for a new test VM.

1. Run the minimal filesystem/bootstrap probe:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\CloudToolDebug\01-bootstrap.ps1
   Expect STEP_01_SUCCESS and C:\ProgramData\CloudTool\cloud-init\step-01-bootstrap.log.
   If this works manually but the same probe does not run through user-data, investigate
   Cloudbase-Init/service/metadata dispatch before changing the network logic.
2. Edit 00-config.ps1 with the actual VM addresses and Elastic/monitor flags.
   Leave optional local IP/gateway empty for the original DHCP fallback.
   If Elastic is enabled, supply its exact DHCP address, local gateway and VPC CIDR.
3. Read-only network detection:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\CloudToolDebug\02-detect-network.ps1
   Inspect Role, Index, Address, Prefix, Destination and Gateway. Nothing is applied.
4. From the VM console, apply networking only after step 02 shows the right NICs:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\CloudToolDebug\03-apply-static-network.ps1
   Keeps the original wait/backup/apply/verify/rollback logic. Does not enable RDP/create users.
5. Enable RDP independently:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\CloudToolDebug\04-enable-rdp.ps1
6. Set AppPassword/VtsAdminPassword in 00-config.ps1, then create users independently:
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\CloudToolDebug\05-create-users.ps1
   app is a normal user; vts_admin belongs to Administrators. Existing passwords are preserved.

Each step prints its result in the console. Stop at the first unexpected error and copy
its STEP_ERROR/line/stack information. RDP and users can be tested independently of networking.
Shared log: C:\ProgramData\CloudTool\Logs\windows-debug-steps.log
Network backups: C:\ProgramData\CloudTool\Backups\network-*.json
These are temporary copies of the current production script for manual diagnosis;
the production windows-static-ip.ps1 remains intact.
