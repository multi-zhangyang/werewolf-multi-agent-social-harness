import { Alert, Badge, Button, Card, Col, Descriptions, Empty, Flex, Row, Space, Spin, Table, Tag, Timeline, Typography } from "antd";
import {
  CheckSquareOutlined,
  CommentOutlined,
  CrownOutlined,
  DashboardOutlined,
  EyeInvisibleOutlined,
  HistoryOutlined,
  UserDeleteOutlined,
  UserOutlined
} from "@ant-design/icons";
import { memo, useMemo } from "react";
import type { ReactNode } from "react";
import type { ColumnsType } from "antd/es/table";
import type { Role } from "../../core/types";
import { buildWerewolfReviewModel } from "./werewolfReviewProjection";
import type {
  WerewolfReviewLedgerEvent,
  WerewolfReviewSeat,
  WerewolfReviewSource,
  WerewolfReviewSpeech,
  WerewolfReviewVote
} from "./werewolfReviewProjection";

const { Paragraph, Text } = Typography;

const ROLE_LABELS: Record<Role, string> = {
  villager: "村民",
  werewolf: "狼人",
  seer: "预言家",
  witch: "女巫",
  hunter: "猎人"
};

function cardTitle(icon: ReactNode, text: string) {
  return (
    <Space size={6}>
      <span aria-hidden="true" style={{ color: "#3558d6" }}>{icon}</span>
      <span>{text}</span>
    </Space>
  );
}

const numericCell = () => ({ style: { fontVariantNumeric: "tabular-nums" as const } });

const VOTE_LEDGER_COLUMNS: ColumnsType<WerewolfReviewVote> = [
  { title: "日", dataIndex: "day", width: 58, onCell: numericCell },
  { title: "票种", dataIndex: "kind", render: (kind) => (kind === "sheriff" ? "警长" : "放逐") },
  { title: "投票者", dataIndex: "voterId" },
  { title: "目标", render: (_, row) => (row.abstain ? "弃票" : row.targetId ?? "—") },
  { title: "权重", dataIndex: "weight", width: 68, onCell: numericCell }
];
const VOTE_LEDGER_SCROLL = { x: "max-content" } as const;

export const WerewolfReviewBoard = memo(function WerewolfReviewBoard({
  reviewSource,
  source = { kind: "artifact-final" },
  onSelectReplayBoundary,
  loading = false,
  error = null
}: {
  reviewSource: WerewolfReviewSource | null;
  source?: { kind: "artifact-final" | "replay-frame"; nativeStepCount?: number; stateHash?: string };
  /** Requests an existing server replay frame; it never performs browser replay. */
  onSelectReplayBoundary?: (nativeStepCount: number) => void;
  loading?: boolean;
  error?: string | null;
}) {
  // Built inside the lazy board chunk so the cockpit shell neither bundles
  // nor recomputes the review projection while this board is unmounted.
  const review = useMemo(() => buildWerewolfReviewModel(reviewSource), [reviewSource]);
  if (loading) {
    return (
      <section data-testid="werewolf-review-board">
        <Flex vertical align="center" justify="center" gap="middle" style={{ minHeight: 180 }}>
          <Spin />
          <Text type="secondary">正在从服务端的已记录原生步骤重建回放局面…</Text>
        </Flex>
      </section>
    );
  }
  if (error) {
    return (
      <section data-testid="werewolf-review-board">
        <Alert
          type="error"
          showIcon
          title="服务端回放帧不可用"
          description={error}
        />
      </section>
    );
  }
  if (!review) {
    return (
      <section data-testid="werewolf-review-board">
        <Empty description="请选择一份服务端记录的狼人杀工件以查看赛后复盘。" />
      </section>
    );
  }

  const truthRedacted = review.visibility === "truth-redacted";
  return (
    <Flex vertical gap="middle" data-testid="werewolf-review-board">
      {truthRedacted ? (
        <Alert
          type="warning"
          showIcon
          title="真相脱敏局面"
          description="仅显示服务端投影中的公开局面、公开发言、公开投票和公开事件；座位身份不会由浏览器推断。"
        />
      ) : (
        <div className="domain-provenance" role="note" aria-label="狼人杀复盘来源">
          <Text strong>{source.kind === "replay-frame" ? "狼人杀回放局面" : "狼人杀赛后复盘"}</Text>
          <Text type="secondary">
            {source.kind === "replay-frame"
              ? `服务端基于已记录原生步骤重放的 native #${source.nativeStepCount ?? "?"} · state ${source.stateHash ?? "n/a"}`
              : "来源是本地赛后记录工件，不是 live state；私有推理和夜间动作已脱敏。"}
          </Text>
        </div>
      )}

      <Card title={cardTitle(<DashboardOutlined />, "局面概览")} variant="borderless">
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 4 }}
          items={[
            { key: "day", label: "第几天", children: review.day ?? "—" },
            { key: "phase", label: "阶段", children: review.phase ?? "—" },
            { key: "speaker", label: "当前发言座位", children: review.currentSpeakerSeat ?? "—" },
            { key: "pending", label: "待处理动作", children: review.pendingActionCount ?? "—" }
          ]}
        />
      </Card>

      <section aria-label="狼人杀座位复盘">
        <Flex className="workspace-section-heading" justify="space-between" align="center" gap="small" wrap="wrap">
          <Text strong>九人座位</Text>
          <Tag color={truthRedacted ? "gold" : "blue"} icon={truthRedacted ? <EyeInvisibleOutlined /> : undefined}>
            {truthRedacted ? "身份隐藏" : "赛后角色可见"}
          </Tag>
        </Flex>
          <div role="list">
            <Row gutter={[12, 12]}>
              {review.seats.map((seat) => (
                <Col key={seat.id} xs={24} sm={12} lg={8}>
                  <SeatCard seat={seat} truthRedacted={truthRedacted} />
                </Col>
              ))}
            </Row>
          </div>
          {!review.seats.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="工件未提供可显示的座位记录。" /> : null}
      </section>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title={cardTitle(<CommentOutlined />, "公开发言")} variant="borderless">
            <PublicSpeechFeed speeches={review.speeches} />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title={cardTitle(<CheckSquareOutlined />, "公开投票账本")} variant="borderless">
            <VoteLedger votes={review.votes} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card title={cardTitle(<UserDeleteOutlined />, "死亡记录")} variant="borderless">
            {review.deaths.length ? (
              <Timeline
                items={review.deaths.map((death, index) => ({
                  color: "red",
                  content: `第 ${death.day} 天 · ${death.playerId} · ${death.reason}`,
                  key: `${death.playerId}-${index}`
                }))}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开死亡记录。" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title={cardTitle(<HistoryOutlined />, "服务端事件账本")} variant="borderless">
            <PublicEventTimeline events={review.eventLedger} onSelectReplayBoundary={onSelectReplayBoundary} />
          </Card>
        </Col>
      </Row>
    </Flex>
  );
});

function SeatCard({ seat, truthRedacted }: { seat: WerewolfReviewSeat; truthRedacted: boolean }) {
  const elimination = seat.eliminatedAt
    ? `第 ${seat.eliminatedAt.day} 天 · ${seat.eliminatedAt.phase} · ${seat.eliminatedAt.reason}`
    : "仍在场上";
  return (
    <article role="listitem" data-testid={`werewolf-seat-${seat.seat}`}>
      <Card size="small" style={{ height: "100%", borderColor: seat.alive ? "#ccd5f4" : "#ecc8c5" }}>
        <Flex justify="space-between" align="start" gap="small">
          <Space orientation="vertical" size={2}>
            <Text strong>
              <UserOutlined /> {seat.seat} 号 · {seat.name}
            </Text>
            <Space size={4} wrap>
              <Badge status={seat.alive ? "success" : "error"} text={seat.alive ? "存活" : "已出局"} />
              {seat.isSheriff ? <Tag color="gold" icon={<CrownOutlined />}>警长</Tag> : null}
            </Space>
          </Space>
          {truthRedacted ? (
            <Tag>身份隐藏</Tag>
          ) : seat.postgameRole ? (
            <Tag color="purple" data-testid={`werewolf-seat-role-${seat.seat}`}>
              {ROLE_LABELS[seat.postgameRole]}
            </Tag>
          ) : (
            <Tag>身份未公开</Tag>
          )}
        </Flex>
        <Paragraph type="secondary" style={{ margin: "10px 0 0", fontSize: 12 }}>
          {elimination}
        </Paragraph>
      </Card>
    </article>
  );
}

function PublicSpeechFeed({ speeches }: { speeches: WerewolfReviewSpeech[] }) {
  if (!speeches.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开发言。" />;
  return (
    <div className="evidence-list" role="list">
      {speeches.map((speech, index) => (
        <div key={`${speech.day}-${speech.playerId}-${index}`} className="evidence-list__item" role="listitem">
          <Flex vertical gap={4}>
            <Space wrap size={4}>
              <Tag>第 {speech.day} 天</Tag>
              <Tag color={speech.kind === "last_words" ? "volcano" : "blue"}>{speech.kind === "last_words" ? "遗言" : "发言"}</Tag>
              <Text strong>{speech.playerId}</Text>
              {speech.claimedRole ? <Tag>{`自称 ${ROLE_LABELS[speech.claimedRole]}`}</Tag> : null}
              {speech.pressureTargetId ? <Tag color="orange">压力：{speech.pressureTargetId}</Tag> : null}
            </Space>
            <Text>{speech.text}</Text>
            {speech.strategyTags.length ? <Text type="secondary">标签：{speech.strategyTags.join(" · ")}</Text> : null}
          </Flex>
        </div>
      ))}
    </div>
  );
}

function VoteLedger({ votes }: { votes: WerewolfReviewVote[] }) {
  return votes.length ? (
    <Table<WerewolfReviewVote>
      size="small"
      rowKey={(row, index) => `${row.day}-${row.kind}-${row.voterId}-${index}`}
      pagination={false}
      columns={VOTE_LEDGER_COLUMNS}
      dataSource={votes}
      scroll={VOTE_LEDGER_SCROLL}
    />
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开投票。" />
  );
}

function PublicEventTimeline({
  events,
  onSelectReplayBoundary
}: {
  events: WerewolfReviewLedgerEvent[];
  onSelectReplayBoundary?: (nativeStepCount: number) => void;
}) {
  if (!events.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="服务端未提供可展示的公开事件账本。" />;
  return (
    <Timeline
      items={events.map((event) => ({
        color: "blue",
        key: event.id,
        content: <PublicEventRow event={event} onSelectReplayBoundary={onSelectReplayBoundary} />
      }))}
    />
  );
}

function PublicEventRow({
  event,
  onSelectReplayBoundary
}: {
  event: WerewolfReviewLedgerEvent;
  onSelectReplayBoundary?: (nativeStepCount: number) => void;
}) {
  return (
    <Flex vertical gap={2}>
      <Text strong>{event.safeLabel}</Text>
      <Text type="secondary">#{event.seq} · 第 {event.day} 天 · {event.phase}</Text>
      {event.nativeStepCount && onSelectReplayBoundary ? (
        <Button
          type="link"
          size="small"
          style={{ paddingInline: 0, width: "fit-content" }}
          onClick={() => onSelectReplayBoundary(event.nativeStepCount!)}
          aria-label={`定位事件 ${event.seq} 的服务端回放边界 ${event.nativeStepCount}`}
        >
          定位服务端回放边界 #{event.nativeStepCount}
        </Button>
      ) : null}
    </Flex>
  );
}
