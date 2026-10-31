/**
 * EventBridge の Durable Object の名前
 *
 * doorbell と doorbell-admin で共有する。名前が食い違うと、別の空のインスタンスを作ってしまうためである。
 */
export const BRIDGE_NAME = "main";
