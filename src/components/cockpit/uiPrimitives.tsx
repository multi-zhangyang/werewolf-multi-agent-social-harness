import { useEffect, useRef } from "react";
import { Layout, Table as AntTable, Typography } from "antd";
import type { TableProps } from "antd";

export const DEFAULT_TABLE_SCROLL = { x: "max-content" } as const;

export function Table<RecordType extends object>(props: TableProps<RecordType>) {
  // Evidence tables may be wider than a compact cockpit viewport. Keep that
  // overflow within the table so it never widens the page or mobile drawers.
  const hostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const scrollRegions = hostRef.current?.querySelectorAll<HTMLElement>(".ant-table-content, .ant-table-body") ?? [];
    for (const region of scrollRegions) {
      region.tabIndex = 0;
      if (!region.getAttribute("aria-label")) region.setAttribute("aria-label", "可横向滚动的数据表");
    }
  });
  return (
    <div ref={hostRef} className="cockpit-table-host">
      <AntTable {...props} scroll={props.scroll ?? DEFAULT_TABLE_SCROLL} />
    </div>
  );
}

export const { Header, Sider, Content } = Layout;
export const { Text, Title, Paragraph } = Typography;
