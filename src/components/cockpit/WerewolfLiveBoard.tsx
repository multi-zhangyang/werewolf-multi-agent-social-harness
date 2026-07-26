import { Alert, Badge, Card, Col, Descriptions, Empty, Flex, Row, Space, Tag, Timeline, Typography } from "antd";
import {
  CheckSquareOutlined,
  CommentOutlined,
  CrownOutlined,
  DashboardOutlined,
  EyeInvisibleOutlined,
  UserDeleteOutlined,
  UserOutlined
} from "@ant-design/icons";
import type { ReactNode } from "react";
import type { LiveMatchProjection, WerewolfLivePublicStateView } from "./werewolfLiveProjection";

const { Paragraph, Text } = Typography;

function cardTitle(icon: ReactNode, text: string) {
  return (
    <Space size={6}>
      <span aria-hidden="true" style={{ color: "#3558d6" }}>{icon}</span>
      <span>{text}</span>
    </Space>
  );
}

/**
 * A running table is deliberately less capable than the postgame review
 * board. It receives a server-owned, white-listed public projection and has
 * no replay, artifact, scheduler, model, role, or private-social controls.
 */
export function WerewolfLiveBoard({ projection, pollError = null }: { projection: LiveMatchProjection; pollError?: string | null }) {
  if (projection.lifecycle !== "running") {
    const terminalLabel =
      projection.lifecycle === "completed" ? "完成" : projection.lifecycle === "truncated" ? "截断" : "失败";
    return (
      <section data-testid="werewolf-live-board">
        <Alert
          type={projection.lifecycle === "failed" ? "error" : "info"}
          showIcon
          title={`实时公开局已${terminalLabel}`}
          description={
            projection.artifactAvailable
              ? "服务端已生成赛后脱敏工件，Cockpit 正在切换到记录工件。"
              : "服务端没有可加载的赛后工件；浏览器不会从实时局面推断、补写或重建它。"
          }
        />
      </section>
    );
  }

  if (!projection.publicState) {
    return (
      <section data-testid="werewolf-live-board">
        <Alert
          type="info"
          showIcon
          title="实时公开局正在启动"
          description="等待服务端第一个已提交边界的公开投影；浏览器不会自行推进游戏状态。"
        />
      </section>
    );
  }

  const state = projection.publicState;
  return (
    <Flex vertical gap="middle" data-testid="werewolf-live-board" aria-live="polite">
      <div className="domain-provenance" role="note" aria-label="实时公开局面来源">
        <EyeInvisibleOutlined />
        <Text strong>实时公开局面 · 服务端权威</Text>
        <Text type="secondary">只呈现已提交边界的公开事实；私密行动、角色与 Agent 私有状态不在此视图中。</Text>
      </div>
      {pollError ? <Alert type="warning" showIcon title="实时公开视图暂时不可用" description={pollError} /> : null}

      <Card title={cardTitle(<DashboardOutlined />, "公开局面概览")} variant="borderless">
        <Descriptions
          size="small"
          column={{ xs: 1, sm: 2, lg: 4 }}
          items={[
            { key: "day", label: "第几天", children: state.day },
            { key: "phase", label: "公开阶段", children: livePhaseLabel(state.phase) },
            { key: "speaker", label: "当前公开发言座位", children: state.currentSpeakerSeat ?? "—" },
            { key: "alive", label: "存活人数", children: state.players.filter((player) => player.alive).length }
          ]}
        />
      </Card>

      <section aria-label="狼人杀实时公开座位">
        <Flex className="workspace-section-heading" justify="space-between" align="center" gap="small" wrap="wrap">
          <Text strong>公开座位</Text>
          <Tag color="blue" icon={<EyeInvisibleOutlined />}>仅公开事实</Tag>
        </Flex>
          <div role="list">
            <Row gutter={[12, 12]}>
              {state.players.map((player) => (
                <Col key={player.id} xs={24} sm={12} lg={8} xl={6}>
                  <LiveSeatCard player={player} />
                </Col>
              ))}
            </Row>
          </div>
          {!state.players.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="服务端尚未投影公开座位。" /> : null}
      </section>

      <Row gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card title={cardTitle(<CommentOutlined />, "公开发言")} variant="borderless">
            <PublicSpeechFeed speeches={state.speeches} />
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card title={cardTitle(<CheckSquareOutlined />, "公开投票")} variant="borderless">
            <PublicVoteFeed votes={state.votes} />
          </Card>
        </Col>
      </Row>

      <Card title={cardTitle(<UserDeleteOutlined />, "公开死亡记录")} variant="borderless">
        {state.deaths.length ? (
          <Timeline
            items={state.deaths.map((death, index) => ({
              color: "red",
              key: `${death.day}-${death.playerId}-${index}`,
              content: `第 ${death.day} 天 · ${death.playerId} · ${death.reason}`
            }))}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开死亡记录。" />
        )}
      </Card>
    </Flex>
  );
}

function LiveSeatCard({ player }: { player: WerewolfLivePublicStateView["players"][number] }) {
  const elimination = player.eliminatedAt ? `第 ${player.eliminatedAt.day} 天 · ${player.eliminatedAt.reason}` : "仍在场上";
  return (
    <article role="listitem" data-testid={`werewolf-live-seat-${player.seat}`}>
      <Card size="small" style={{ height: "100%", borderColor: player.alive ? "#ccd5f4" : "#ecc8c5" }}>
        <Flex justify="space-between" align="start" gap="small">
          <Space orientation="vertical" size={2}>
            <Text strong>
              <UserOutlined /> {player.seat} 号 · {player.name}
            </Text>
            <Space size={4} wrap>
              <Badge status={player.alive ? "success" : "error"} text={player.alive ? "存活" : "已出局"} />
              {player.isSheriff ? <Tag color="gold" icon={<CrownOutlined />}>警长</Tag> : null}
            </Space>
          </Space>
          <Tag>身份未知</Tag>
        </Flex>
        <Paragraph type="secondary" style={{ margin: "10px 0 0", fontSize: 12 }}>
          {elimination}
        </Paragraph>
      </Card>
    </article>
  );
}

function PublicSpeechFeed({ speeches }: { speeches: WerewolfLivePublicStateView["speeches"] }) {
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
            </Space>
            <Text>{speech.text}</Text>
          </Flex>
        </div>
      ))}
    </div>
  );
}

function PublicVoteFeed({ votes }: { votes: WerewolfLivePublicStateView["votes"] }) {
  if (!votes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无公开投票。" />;
  return (
    <div className="evidence-list" role="list">
      {votes.map((vote, index) => (
        <div key={`${vote.day}-${vote.voterId}-${index}`} className="evidence-list__item" role="listitem">
          <Space wrap>
            <Tag>第 {vote.day} 天</Tag>
            <Text strong>{vote.voterId}</Text>
            <Text>→</Text>
            <Text>{vote.abstain ? "弃票" : vote.targetId ?? "未公开目标"}</Text>
          </Space>
        </div>
      ))}
    </div>
  );
}

function livePhaseLabel(phase: WerewolfLivePublicStateView["phase"]): string {
  if (phase === "night") return "夜晚";
  if (phase === "day") return "白天";
  return "游戏结束";
}
