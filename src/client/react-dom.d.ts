/**
 * react-dom 在客户端 bundle 里是 external(宿主提供,见 scripts/bundle-client.mjs)。
 * as-one 未装 @types/react-dom,这里只为 createPortal 声明最小签名。
 */
declare module "react-dom" {
  import type { ReactNode, ReactPortal } from "react";
  export function createPortal(
    children: ReactNode,
    container: Element | DocumentFragment,
    key?: null | string,
  ): ReactPortal;
}
