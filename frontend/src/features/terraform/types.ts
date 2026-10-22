export interface ServerVolumeDraft {
  id: string
  volume_type: string
  volume_type_name: string
  size: number
  mount_as: 'root' | 'data'
  mount_point?: string
}

export interface TerraformServerDraft {
  id: string
  name: string
  zone_id: string
  zone_name: string
  region_id: string
  instance_family: 'basic' | 'gpu'
  specs_kind: 'predefined' | 'custom'
  flavor_name: string
  ram: number
  vcpus: number
  boot_source: 'public_image'
  image_id: string
  image_name: string
  image_display_name: string
  key_pair_id: string
  key_pair_name: string
  bandwidth: number
  enable_ipv4: boolean
  elastic_ip_mode: 'none' | 'auto' | 'existing' | 'manual'
  elastic_ip_id: string
  elastic_ip_address: string
  private_network_mode: 'subnet' | 'eni'
  private_ip_mode: 'auto' | 'existing' | 'ordered' | 'manual'
  subnet_id: string
  subnet_display_name: string
  subnet_cidr?: string
  vpc_cidr?: string
  eni_id: string
  eni_address: string
  security_group_ids: string[]
  security_group_names: string[]
  placement_group_id: string
  placement_group_name: string
  volumes: ServerVolumeDraft[]
  cloud_init_enabled: boolean
  cloud_init_content: string
  cloud_init_template_id: string
  cloud_init_template_name: string
  cloud_init_variables: Record<string, string>
  teleport_enabled: boolean
  teleport_region: 'public' | 'vpublic'
  teleport_system: string
  teleport_hostname: string
  teleport_monitor_ip: string
  teleport_monitor_subnet_id: string
  teleport_monitor_subnet_name: string
}

export type TerraformServerFieldErrors = Partial<
  Record<keyof TerraformServerDraft, string>
>
