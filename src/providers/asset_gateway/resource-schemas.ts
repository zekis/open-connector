import type { JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";

const nullableText = (description: string): JsonSchema => s.nullableString(description);
const nullableId = (description: string): JsonSchema => s.nullableInteger(description, { minimum: 1 });

const networkSchema = s.object("Latest stored network details reported by the device agent.", {
  public_ip: nullableText("The latest public IP address."),
  lan_ip: nullableText("The primary LAN IP address."),
  mac_address: nullableText("The primary network interface MAC address."),
  wifi: nullableText("The connected Wi-Fi network name."),
  isp: nullableText("The reported internet service provider."),
  timezone: nullableText("The reported device timezone."),
  city: nullableText("The effective city after any location override."),
  country: nullableText("The reported country."),
});

const hardwareSchema = s.object("Allowlisted hardware, operating-system, and latest check-in note fields.", {
  OS: nullableText("The operating system description."),
  CPU: nullableText("The processor description."),
  RAM: nullableText("The reported memory capacity."),
  Disk: nullableText("The reported disk capacity."),
  MAC: nullableText("The primary MAC address."),
  "LAN IP": nullableText("The primary LAN IP address."),
  "Public IP": nullableText("The public IP address."),
  Location: nullableText("The agent-reported location description."),
  ISP: nullableText("The reported internet service provider."),
  Timezone: nullableText("The reported timezone."),
  "Wi-Fi": nullableText("The connected Wi-Fi network name."),
  User: nullableText("The logged-in user reported by the agent."),
  "Last check-in": nullableText("The check-in timestamp reported in the hardware notes."),
});

const inventorySchema = s.object("Allowlisted upstream inventory identifiers reported by the device agent.", {
  name: s.unknown("The reported inventory name."),
  serial: s.unknown("The reported serial or stable hardware identifier."),
  model_id: s.unknown("The upstream model identifier."),
  status_id: s.unknown("The upstream status identifier."),
  company_id: s.unknown("The upstream company identifier."),
  rtd_location_id: s.unknown("The upstream ready-to-deploy location identifier."),
});

const reportedLocationSchema = s.object("The original location reported by the agent before any IP override.", {
  latitude: s.nullableNumber("The reported latitude."),
  longitude: s.nullableNumber("The reported longitude."),
  geo_city: nullableText("The reported city."),
  geo_country: nullableText("The reported country."),
});

const tailscaleNodeSchema = s.object("The allowlisted Tailscale self-node details.", {
  hostname: nullableText("The node hostname."),
  dns_name: nullableText("The node's Tailscale DNS name."),
  os: nullableText("The node operating system."),
  online: s.boolean("Whether the node was reported online."),
  relay: nullableText("The relay region used by the node."),
  addrs: s.stringArray("The node addresses."),
  rx_bytes: s.nonNegativeInteger("Bytes received by the node."),
  tx_bytes: s.nonNegativeInteger("Bytes transmitted by the node."),
  created: nullableText("The node creation timestamp."),
  last_seen: nullableText("The node's last-seen timestamp."),
  last_handshake: nullableText("The most recent handshake timestamp."),
  exit_node: s.boolean("Whether this node is using an exit node."),
  capabilities: s.stringArray("Allowlisted node capabilities."),
});

const tailscalePeerSchema = s.object("One allowlisted Tailscale peer record.", {
  hostname: nullableText("The peer hostname."),
  dns_name: nullableText("The peer's Tailscale DNS name."),
  os: nullableText("The peer operating system."),
  online: s.boolean("Whether the peer was reported online."),
  tailscale_ips: s.stringArray("The peer's Tailscale IP addresses."),
  relay: nullableText("The relay region used by the peer."),
  last_seen: nullableText("The peer's last-seen timestamp."),
  rx_bytes: s.nonNegativeInteger("Bytes received from the peer."),
  tx_bytes: s.nonNegativeInteger("Bytes transmitted to the peer."),
});

const tailscaleSchema = s.object("Allowlisted Tailscale status without login URLs or credentials.", {
  installed: s.boolean("Whether Tailscale is installed."),
  version: nullableText("The installed Tailscale version."),
  backend_state: nullableText("The Tailscale backend state."),
  tun: s.boolean("Whether the Tailscale tunnel is active."),
  have_node_key: s.boolean("Whether Tailscale reports an available node key."),
  tailscale_ips: s.stringArray("The device's Tailscale IP addresses."),
  health: s.stringArray("Tailscale health messages."),
  peer_count: s.nonNegativeInteger("The number of reported peers."),
  error: nullableText("A collection error, when present."),
  self: tailscaleNodeSchema,
  peers: s.array("Allowlisted peer status and traffic details.", tailscalePeerSchema),
});

const virtualMachineSchema = s.object("One virtual-machine inventory record.", {
  id: nullableText("The runtime-specific virtual-machine identifier."),
  type: nullableText("The hypervisor or virtual-machine type."),
  name: nullableText("The virtual-machine name."),
  state: nullableText("The virtual-machine state."),
});

const containerSchema = s.object("One container inventory record.", {
  id: nullableText("The runtime-specific container identifier."),
  type: nullableText("The container runtime type."),
  name: nullableText("The container name."),
  image: nullableText("The container image."),
  status: nullableText("The container status text."),
  state: nullableText("The container state."),
});

const virtualizationSchema = s.object("Host virtualization capabilities and reported VM/container inventory.", {
  hypervisor: nullableText("The detected host hypervisor."),
  is_virtual_machine: s.boolean("Whether this device is itself a virtual machine."),
  docker_installed: s.boolean("Whether Docker is installed."),
  podman_installed: s.boolean("Whether Podman is installed."),
  libvirt_installed: s.boolean("Whether libvirt is installed."),
  hyperv_installed: s.boolean("Whether Hyper-V is installed."),
  virtualbox_installed: s.boolean("Whether VirtualBox is installed."),
  vm_count: s.nonNegativeInteger("The number of reported virtual machines."),
  container_count: s.nonNegativeInteger("The number of reported containers."),
  vms: s.array("Reported virtual machines.", virtualMachineSchema),
  containers: s.array("Reported containers.", containerSchema),
});

const sshPublicKeySchema = s.object("One installed SSH public key; private keys are never returned.", {
  type: s.nonEmptyString("The SSH public-key algorithm."),
  public_key: s.nonEmptyString("The public-key algorithm and encoded public value."),
  comment: s.string("The public-key comment."),
  user: nullableText("The local user associated with the key."),
  managed: s.boolean("Whether the key is marked as managed by the portal."),
});

const deviceGroupSchema = s.object("One device group containing the device.", {
  id: s.positiveInteger("The device-group ID."),
  name: s.nonEmptyString("The device-group name."),
  description: s.string("The device-group description."),
  company_name: s.nonEmptyString("The owning company name."),
});

export const deviceRecordSchema: JsonSchema = s.object(
  "A device inventory record with current allowlisted telemetry.",
  {
    id: s.positiveInteger("The device ID."),
    device_label: s.nonEmptyString("The configured device label."),
    device_hostname: nullableText("The hostname last reported by the device agent."),
    hardware_id: nullableText("The stable hardware identifier reported by the agent."),
    company_id: nullableId("The upstream company identifier."),
    company_name: s.nonEmptyString("The company name."),
    location: s.string("The configured location."),
    enrolled_by: s.nonEmptyString("The user or API identity that created the enrollment record."),
    logged_in_user: nullableText("The user last reported as logged in."),
    allocated_to: s.string("The person or account to which the device is allocated."),
    created_at: s.nonEmptyString("The enrollment creation timestamp."),
    last_used: nullableText("The most recent agent check-in timestamp."),
    active: s.boolean("Whether device-agent check-in remains enabled."),
    online: s.boolean("Whether the active device checked in within the portal's online window."),
    agent_script_hash: nullableText("The hash of the agent script reported at the latest check-in."),
    update_pending: s.boolean("Whether an agent update is pending."),
    public_ip: nullableText("The latest public IP address."),
    latitude: s.nullableNumber("The effective latitude after any IP override."),
    longitude: s.nullableNumber("The effective longitude after any IP override."),
    geo_city: nullableText("The effective city after any IP override."),
    geo_country: nullableText("The reported country."),
    overridden: s.boolean("Whether an IP location override is active."),
    reported_location: reportedLocationSchema,
    network: networkSchema,
    hardware: hardwareSchema,
    inventory: inventorySchema,
    purchased_on: s.string("The purchase date, when recorded."),
    reseller: s.string("The reseller or supplier."),
    order_reference: s.string("The purchase order or reseller reference."),
    warranty_until: s.string("The warranty end date, when recorded."),
    warranty_provider: s.string("The warranty provider."),
    tailscale: tailscaleSchema,
    virtualization: virtualizationSchema,
    installed_ssh_keys: s.array("Installed SSH public-key inventory.", sshPublicKeySchema),
    groups: s.array("Device groups containing this device, ordered by name.", deviceGroupSchema),
  },
);

export const requestRecordSchema: JsonSchema = s.object("An asset request record.", {
  id: s.positiveInteger("The request ID."),
  company_name: s.nonEmptyString("The company name."),
  title: s.nonEmptyString("The request title."),
  description: s.string("The request description."),
  recipient: s.nonEmptyString("The intended recipient."),
  status: s.nonEmptyString("The current request status."),
  asset_type: s.nonEmptyString("The requested asset type."),
  license_type: s.string("The software licence type, when applicable."),
  renewal_on: s.string("The software licence renewal date, when applicable."),
  reseller: s.string("The reseller or supplier."),
  reseller_options: s.string("Reseller options or quotation detail."),
  order_reference: s.string("The purchase order or reseller reference."),
  purchased_on: s.string("The purchase date, when recorded."),
  expected_on: s.string("The expected delivery date, when recorded."),
  delivered_on: s.string("The delivery date, when recorded."),
  warranty_until: s.string("The warranty end date, when recorded."),
  warranty_provider: s.string("The warranty provider."),
  enrollment_id: nullableId("The linked device ID."),
  template_id: nullableId("The linked asset-template ID."),
  created_by: s.nonEmptyString("The identity that created the request."),
  created_at: s.nonEmptyString("The creation timestamp."),
  updated_at: s.nonEmptyString("The latest update timestamp."),
});

export const ticketRecordSchema: JsonSchema = s.object("A support ticket record.", {
  id: s.positiveInteger("The ticket ID."),
  company_name: s.nonEmptyString("The company name."),
  title: s.nonEmptyString("The ticket title."),
  description: s.string("The ticket description."),
  priority: s.nonEmptyString("The current priority."),
  status: s.nonEmptyString("The current ticket status."),
  enrollment_id: nullableId("The linked device ID."),
  assigned_to: s.string("The assigned person."),
  created_by: s.nonEmptyString("The identity that created the ticket."),
  created_at: s.nonEmptyString("The creation timestamp."),
  updated_at: s.nonEmptyString("The latest update timestamp."),
});

export const historyEventSchema: JsonSchema = s.object("One asset history event or internal comment.", {
  id: s.positiveInteger("The history event ID."),
  company_name: s.nonEmptyString("The company name."),
  enrollment_id: nullableId("The related device ID."),
  request_id: nullableId("The related request ID."),
  ticket_id: nullableId("The related ticket ID."),
  body: s.nonEmptyString("The event or comment body."),
  created_by: s.nonEmptyString("The user, agent, or API identity that created the event."),
  created_at: s.nonEmptyString("The event timestamp."),
});

export const deviceCheckinSchema: JsonSchema = s.object("One device-agent check-in log entry.", {
  id: s.positiveInteger("The check-in ID."),
  checked_in_at: s.nonEmptyString("The check-in timestamp."),
  public_ip: nullableText("The public IP address reported for the check-in."),
  geo_city: nullableText("The city reported for the check-in."),
  latitude: s.nullableNumber("The latitude reported for the check-in."),
  longitude: s.nullableNumber("The longitude reported for the check-in."),
  logged_in_user: nullableText("The logged-in user reported for the check-in."),
  device_hostname: nullableText("The hostname reported for the check-in."),
});
