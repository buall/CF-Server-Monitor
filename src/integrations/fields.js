const PUBLIC_FIELDS = new Set(('id name server_group region tags price billing_cycle auto_renewal currency expire_date traffic_limit traffic_calc_type reset_day report_interval is_hidden sort_order cpu load_avg net_in_speed net_out_speed net_rx net_tx net_rx_monthly net_tx_monthly processes tcp_conn udp_conn ram_total ram_used swap_total swap_used disk_total disk_used disk cpu_cores cpu_info gpu_info arch os kernel_version ip_v4 ip_v6 boot_time agent_version last_updated timestamp ping loss').split(' '));
for (const probe of ['ct', 'cu', 'cm', 'bd', 'node_1', 'node_2', 'node_3', 'node_4']) {
  PUBLIC_FIELDS.add(`ping_${probe}`); PUBLIC_FIELDS.add(`loss_${probe}`);
}

export function publicMetrics(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([key]) => PUBLIC_FIELDS.has(key)));
}
