# Edit this file before running steps 02-05 manually on the VM.
# Empty local IP/gateway: detect the current DHCP address/gateway.
$DesiredPrivateIP = ''
$DesiredGateway = ''
$ElasticEnabled = 'false' # Set 'true' only when the Elastic NIC exists.
$ElasticIP = ''          # Exact Elastic IPv4 currently assigned by DHCP.
$VpcCidr = ''            # Required with Elastic, e.g. '10.1.27.0/24'.
$MonitorEnabled = 'false'
$MonitorIP = ''          # Monitor IPv4, if present.

# Required only for accounts that do not exist. Existing passwords are unchanged.
$AppPassword = ''
$VtsAdminPassword = ''
