import { Alert, Badge, Card, Col, Descriptions, Empty, Flex, Row, Space, Spin, Table, Tag, Timeline, Typography } from "antd";
import { CrownOutlined, EyeInvisibleOutlined, UserOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import type { Role } from "../../core/types";
import type {
  WerewolfReviewModel,
  WerewolfReviewPublicEvent,
  WerewolfReviewSeat,
  WerewolfReviewSpeech,
  WerewolfReviewVote
} from "./werewolfReviewProjection";

const { Paragraph, Text, Title } = Typography;

const ROLE_LABELS: Record<Role, string> = {
  villager: "村民",
  werewolf: "狼人",
  seer: "预言家",
  witch: "女巫",
  hunter: "猎人"
};

export function WerewolfReviewBoard({
  review,
  source = { kind: "artifact-final" },
  loading = false,
  error = null
}: {
  review: WerewolfReviewModel | null;
  source?: { kind: "artifact-final" | "replay-frame"; nativeStepCount?: number; stateHash?: string };
  loading?: boolean;
  error?: string | null;
}) {
  if (loading) {
    return (
      <Card bordered={false} data-testid="werewolf-review-board">
        <Flex vertical align="center" gap="middle" style={{ minHeight: 180, justifyContent: "center" }}>
          <Spin />
          <Text type="secondary">正在从服务端的已记录原生步骤重建回放局面…</Text>
        </Flex>
      </Card>
    );
  }
  if (error) {
    return (
      <Card bordered={false} data-testid="werewolf-review-board">
        <Alert
          type="error"
          showIcon
          message="服务端回放帧不可用"
          description={error}
        />
      </Card>
    );
  }
  if (!review) {
    return (
      <Card bordered={false} data-testid="werewolf-review-board">
        <Empty description="请选择一份服务端记录的狼人杀工件以查看赛后复盘。" />
      </Card>
    );
  }

  const truthRedacted = review.visibility === "truth-redacted";
  return (
    <Flex vertical gap="middle" data-testid="werewolf-review-board">
      <Alert
        type={truthRedacted ? "warning" : "info"}
        showIcon
        message={truthRedacted ? "真相脱敏局面" : source.kind === "replay-frame" ? "狼人杀回放局面" : "狼人杀赛后复盘"}
        description={
          truthRedacted
            ? "仅显示服务端投影中的公开局面、公开发言、公开投票和公开事件；座位身份不会由浏览器推断。"
            : source.kind === "replay-frame"
              ? `这是服务端基于已记录原生步骤重放的第 ${source.nativeStepCount ?? "?"} 帧，不是浏览器推演或 live state。state hash：${source.stateHash ?? "n/a"}`
              : "这是本地赛后复盘工件，不是 live public state。私有推理和证据已脱敏；本面板不显示夜间私密动作或阵营关系。"
        }
      />

      <Card title="局面概览" bordered={false}>
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }}>
          <Descriptions.Item label="第几天">{review.day ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="阶段">{review.phase ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="当前发言座位">{review.currentSpeakerSeat ?? "—"}</Descriptions.Item>
          <Descriptions.Item label="待处理动作">{review.pendingActionCount ?? "—"}</Descriptions.Item>
        </Descriptions>
      </Card>

      <section aria-label="狼人杀座位复盘">
        <Card
          title="九人座位"
          extra={
            <Tag color={truthRedacted ? "gold" : "blue"} icon={truthRedacted ? <EyeInvisibleOutlined /> : undefined}>
              {truthRedacted ? "身份隐藏" : "赛后角色可见"}
            </Tag>
          }
          bordered={false}
        >
          <div role="list">
            <Row gutter={[12, 12]}>
              {review.seats.map((seat) => (
                <Col key={seat.id} xs={24} sm={12} lg={8} xl={6}>
                  <SeatCard seat={seat} truthRedacted={truthRedacted} />
                </Col>
              ))}
            </Row>
          </div>
          {!review.seats.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="工件未提供可显示的座位记录。" /> : null}
        </Card>
      </section>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title="公开发言" bordered={false}>
            <PublicSpeechFeed speeches={review.speeches} />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title="公开投票账本" bordered={false}>
            <VoteLedger votes={review.votes} />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={10}>
          <Card title="死亡记录" bordered={false}>
            {review.deaths.length ? (
              <Timeline
                items={review.deaths.map((death, index) => ({
                  color: "red",
                  children: `第 ${death.day} 天 · ${death.playerId} · ${death.reason}`,
                  key: `${death.playerId}-${index}`
                }))}
              />
            ) : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开死亡记录。" />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card title="公开事件时间线" bordered={false}>
            <PublicEventTimeline events={review.publicEvents} />
          </Card>
        </Col>
      </Row>
    </Flex>
  );
}

function SeatCard({ seat, truthRedacted }: { seat: WerewolfReviewSeat; truthRedacted: boolean }) {
  const elimination = seat.eliminatedAt
    ? `第 ${seat.eliminatedAt.day} 天 · ${seat.eliminatedAt.phase} · ${seat.eliminatedAt.reason}`
    : "仍在场上";
  return (
    <article role="listitem" data-testid={`werewolf-seat-${seat.seat}`}>
      <Card size="small" style={{ height: "100%", borderColor: seat.alive ? "#c8d8ff" : "#f0d3d8" }}>
        <Flex justify="space-between" align="start" gap="small">
          <Space direction="vertical" size={2}>
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
    <Flex vertical gap="small">
      {speeches.map((speech, index) => (
        <Card key={`${speech.day}-${speech.playerId}-${index}`} size="small" style={{ background: "#fafcff" }}>
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
        </Card>
      ))}
    </Flex>
  );
}

function VoteLedger({ votes }: { votes: WerewolfReviewVote[] }) {
  const columns: ColumnsType<WerewolfReviewVote> = [
    { title: "日", dataIndex: "day", width: 58 },
    { title: "票种", dataIndex: "kind", render: (kind) => (kind === "sheriff" ? "警长" : "放逐") },
    { title: "投票者", dataIndex: "voterId" },
    { title: "目标", render: (_, row) => (row.abstain ? "弃票" : row.targetId ?? "—") },
    { title: "权重", dataIndex: "weight", width: 68 }
  ];
  return votes.length ? (
    <Table<WerewolfReviewVote>
      size="small"
      rowKey={(row, index) => `${row.day}-${row.kind}-${row.voterId}-${index}`}
      pagination={false}
      columns={columns}
      dataSource={votes}
      scroll={{ x: "max-content" }}
    />
  ) : (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开投票。" />
  );
}

function PublicEventTimeline({ events }: { events: WerewolfReviewPublicEvent[] }) {
  if (!events.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开事件。" />;
  return (
    <Timeline
      items={events.map((event) => ({
        color: "blue",
        key: event.id,
        children: <PublicEventRow event={event} />
      }))}
    />
  );
}

function PublicEventRow({ event }: { event: WerewolfReviewPublicEvent }) {
  return (
    <Flex vertical gap={2}>
      <Text strong>{event.type}</Text>
      <Text type="secondary">#{event.seq} · 第 {event.day} 天 · {event.phase}</Text>
    </Flex>
  );
}
