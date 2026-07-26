import { memo, useMemo } from "react";
import { Button, Empty, Flex, Input, Space, Tag, type TableProps } from "antd";
import { FileSearchOutlined } from "@ant-design/icons";
import { Table, Text, Title, type MatchRecord } from "./appShared";
import { StatusTag, decorativeIcon, shortId, formatDate } from "./appInspectors";

const TABLE_PAGINATION = { pageSize: 8, showSizeChanger: true } as const;
const TABLE_SCROLL = { x: 1120 } as const;
const TABLE_LOCALE = {
  emptyText: <Empty description="没有匹配的 run。调整筛选，或用顶部“运行实验”生成真实 artifact-backed run。" />
} as const;

export const RunsWorkspace = memo(function RunsWorkspace({
  matches,
  selectedMatchId,
  query,
  onQueryChange,
  onLoadArtifact,
  onInspect,
  busy
}: {
  matches: MatchRecord[];
  selectedMatchId: string;
  query: string;
  onQueryChange: (value: string) => void;
  onLoadArtifact: (match: MatchRecord) => void;
  onInspect: (match: MatchRecord) => void;
  busy: string | null;
}) {
  const columns: TableProps<MatchRecord>["columns"] = useMemo(() => [
    {
      title: "run",
      dataIndex: "id",
      fixed: "left",
      render: (_, match) => (
        <Button type="link" size="small" onClick={() => onInspect(match)}>
          <Text code>{shortId(match.id)}</Text>
        </Button>
      )
    },
    {
      title: "status",
      dataIndex: "status",
      render: (status: MatchRecord["status"]) => <StatusTag status={status} />
    },
    { title: "phase", dataIndex: ["state", "phase"] },
    {
      title: "artifact",
      dataIndex: "hasArtifact",
      render: (hasArtifact: boolean) => <Tag color={hasArtifact ? "processing" : "default"}>{hasArtifact ? "available" : "missing"}</Tag>
    },
    {
      title: "models",
      dataIndex: "models",
      ellipsis: true,
      render: (models: string[]) => models.join(", ") || "n/a"
    },
    { title: "native steps", dataIndex: "nativeSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "committed", dataIndex: "committedSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "rejected", dataIndex: "rejectedSteps", render: (value?: number) => (typeof value === "number" ? value : "n/a") },
    { title: "created", dataIndex: "createdAt", render: formatDate },
    {
      title: "action",
      fixed: "right",
      align: "right",
      render: (_, match) => (
        <Button
          size="small"
          icon={decorativeIcon(<FileSearchOutlined />)}
          disabled={!match.hasArtifact || busy === `artifact:${match.id}`}
          loading={busy === `artifact:${match.id}`}
          onClick={() => onLoadArtifact(match)}
        >
          加载工件
        </Button>
      )
    }
  ], [busy, onInspect, onLoadArtifact]);

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Flex justify="space-between" align="center" gap="middle" wrap="wrap">
        <Flex vertical>
          <Title level={4} style={{ margin: 0 }}>
            运行注册表
          </Title>
          <Text type="secondary">真实 `/api/matches` 数据。React 只保存筛选和选择状态。</Text>
        </Flex>
        <Input.Search
          aria-label="搜索运行"
          allowClear
          placeholder="run / model / phase"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          style={{ width: "min(280px, 100%)" }}
        />
      </Flex>
      <Table
        rowKey="id"
        size="small"
        bordered
        loading={busy === "bootstrap" || busy === "matches"}
        columns={columns}
        dataSource={matches}
        rowSelection={{
          type: "radio",
          selectedRowKeys: selectedMatchId ? [selectedMatchId] : []
        }}
        locale={TABLE_LOCALE}
        pagination={TABLE_PAGINATION}
        scroll={TABLE_SCROLL}
      />
    </Space>
  );
});
