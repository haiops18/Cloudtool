type ElasticIpSelection = {
  elastic_ip_mode: 'none' | 'auto' | 'existing' | 'manual'
  elastic_ip_address: string
}

export function elasticIpVariables(
  server: ElasticIpSelection
): Record<string, string> {
  const enabled = server.elastic_ip_mode !== 'none'
  const values: Record<string, string> = { elastic_ip_enabled: String(enabled) }
  if (!enabled) values.elastic_ip_address = ''
  else if (server.elastic_ip_mode === 'existing') {
    const address = server.elastic_ip_address.trim()
    const octets = address.split('.')
    if (
      octets.length === 4 &&
      octets.every(
        (part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
      )
    ) {
      values.elastic_ip_address = address
    }
  }
  // Leave unavailable addresses unresolved in the preview rather than invent
  // an IP for auto allocation or substituting a resource label.
  return values
}

export function elasticIpVariableError(
  server: ElasticIpSelection,
  content: string
): string | undefined {
  if (!/\{\{\s*elastic_ip_address\s*\}\}/.test(content)) return undefined
  if (server.elastic_ip_mode === 'auto')
    return 'Select an existing Elastic IP to use {{elastic_ip_address}}. An automatically allocated address is only available after server creation.'
  if (
    server.elastic_ip_mode === 'existing' &&
    !elasticIpVariables(server).elastic_ip_address
  )
    return 'The selected Elastic IP must have a valid IP address to use {{elastic_ip_address}}.'
}
