import { Alert, Button, Card, Col, Flex, Form, Input, Row, Select, Space } from "antd";
import { type Role, type Team } from "../../core/types";
import { type HarnessAgentProfile, type PolicyName } from "../../harness/types";
import { POLICY_NAMES, type HarnessAssignmentConfig, type HarnessAssignmentStrategy } from "../../harness/profiles";
import { type CockpitExperimentDraft } from "./experimentDraft";

const WEREWOLF_ROSTER_ROLES: Role[] = ["villager", "werewolf", "seer", "witch", "hunter"];
const WEREWOLF_ROSTER_TEAMS: Team[] = ["werewolves", "village"];
const COCKPIT_ASSIGNMENT_OPTIONS: Array<{ value: HarnessAssignmentStrategy; label: string }> = [
  { value: "profile-rotation", label: "profile rotation（默认）" },
  { value: "seat", label: "按座位条件" },
  { value: "role", label: "按角色条件" },
  { value: "team", label: "按阵营条件" }
];

/**
 * A request composer, not a second environment. It only edits the reusable
 * profile/assignment contract accepted by the existing server control plane.
 */
export function ExperimentRosterComposer({
  draft,
  models,
  selectedModel,
  policyNames,
  invalidReason,
  disabled,
  onChange,
  onReset,
  onClose
}: {
  draft: CockpitExperimentDraft;
  models: string[];
  selectedModel: string;
  policyNames: PolicyName[];
  invalidReason?: string;
  disabled: boolean;
  onChange: (draft: CockpitExperimentDraft) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const updateProfile = (index: number, patch: Partial<HarnessAgentProfile>) => {
    onChange({
      ...draft,
      profiles: draft.profiles.map((profile, candidateIndex) => (candidateIndex === index ? { ...profile, ...patch } : profile))
    });
  };
  const removeProfile = (index: number) => onChange({ ...draft, profiles: draft.profiles.filter((_, candidateIndex) => candidateIndex !== index) });
  const addProfile = () => {
    const existingIds = new Set(draft.profiles.map((profile) => profile.id));
    let index = draft.profiles.length + 1;
    let id = `research-agent-${index}`;
    while (existingIds.has(id)) {
      index += 1;
      id = `research-agent-${index}`;
    }
    onChange({
      ...draft,
      profiles: [
        ...draft.profiles,
        {
          id,
          model: selectedModel || models[0] || "",
          temperature: 0.7
        }
      ]
    });
  };
  const setAssignment = (patch: Partial<HarnessAssignmentConfig>) => onChange({
    ...draft,
    assignment: { ...draft.assignment, ...patch }
  });
  const profileOptions = draft.profiles.map((profile) => ({ value: profile.id, label: profile.id || "(缺少 id)" }));
  const modelOptions = Array.from(new Set([...models, ...draft.profiles.map((profile) => profile.model).filter(Boolean)])).map((model) => ({
    value: model,
    label: model
  }));
  const setRoleProfile = (role: Role, value: string | undefined) => {
    const roles = { ...(draft.assignment.roles ?? {}) };
    if (value) roles[role] = value;
    else delete roles[role];
    setAssignment({ roles });
  };
  const setTeamProfile = (team: Team, value: string | undefined) => {
    const teams = { ...(draft.assignment.teams ?? {}) };
    if (value) teams[team] = value;
    else delete teams[team];
    setAssignment({ teams });
  };
  const setSeatProfile = (seat: number, value: string | undefined) => {
    const seats = { ...(draft.assignment.seats ?? {}) };
    if (value) seats[String(seat)] = value;
    else delete seats[String(seat)];
    setAssignment({ seats });
  };

  return (
    <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
      <Alert
        type="info"
        showIcon
        title="控制面草案，不是游戏真相"
        description="这里配置可复用的 profile、模型、policy 和 assignment 条件。服务端使用真实 roster 校验引用，环境在运行时才解析 seat/role/team；浏览器不会推断或保存隐藏身份。"
      />
      {invalidReason ? <Alert type="warning" showIcon title={invalidReason} /> : null}
      <Card
        size="small"
        title="Agent profiles"
        extra={
          <Space>
            <Button size="small" onClick={onReset} disabled={disabled}>
              恢复默认
            </Button>
            <Button size="small" type="primary" onClick={addProfile} disabled={disabled}>
              添加 profile
            </Button>
          </Space>
        }
      >
        <Space orientation="vertical" size="small" style={{ width: "100%" }}>
          {draft.profiles.map((profile, index) => (
            <Card
              size="small"
              key={`${profile.id || "profile"}-${index}`}
              title={`Profile ${index + 1}`}
              extra={
                <Button size="small" danger disabled={disabled || draft.profiles.length <= 1} onClick={() => removeProfile(index)}>
                  删除
                </Button>
              }
            >
              <Row gutter={[8, 8]}>
                <Col xs={24} sm={12}>
                  <Form.Item label="profile id" style={{ marginBottom: 0 }}>
                    <Input
                      aria-label={`profile ${index + 1} id`}
                      value={profile.id}
                      disabled={disabled}
                      onChange={(event) => updateProfile(index, { id: event.target.value })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item label="model" style={{ marginBottom: 0 }}>
                    <Select
                      aria-label={`profile ${index + 1} model`}
                      value={profile.model || undefined}
                      options={modelOptions}
                      disabled={disabled || !modelOptions.length}
                      placeholder="来自 /api/config"
                      onChange={(value) => updateProfile(index, { model: String(value) })}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item label="temperature" style={{ marginBottom: 0 }}>
                    <Input
                      aria-label={`profile ${index + 1} temperature`}
                      inputMode="decimal"
                      value={profile.temperature ?? ""}
                      disabled={disabled}
                      onChange={(event) => {
                        const raw = event.target.value.trim();
                        updateProfile(index, { temperature: raw ? Number(raw) : undefined });
                      }}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} sm={12}>
                  <Form.Item label="policy" style={{ marginBottom: 0 }}>
                    <Select
                      aria-label={`profile ${index + 1} policy`}
                      value={profile.policyName ?? ""}
                      options={[{ value: "", label: "不指定（policy 默认）" }, ...policyNames.map((policy) => ({ value: policy, label: policy }))]}
                      disabled={disabled}
                      onChange={(value) =>
                        updateProfile(index, {
                          policyName: POLICY_NAMES.includes(value as PolicyName) ? (value as PolicyName) : undefined
                        })
                      }
                    />
                  </Form.Item>
                </Col>
              </Row>
            </Card>
          ))}
        </Space>
      </Card>

      <Card size="small" title="Assignment condition">
        <Form layout="vertical" size="small" style={{ marginBottom: 0 }}>
          <Row gutter={[8, 8]}>
            <Col xs={24} sm={12}>
              <Form.Item label="strategy">
                <Select
                  aria-label="Agent assignment strategy"
                  value={draft.assignment.strategy ?? "profile-rotation"}
                  options={COCKPIT_ASSIGNMENT_OPTIONS}
                  disabled={disabled}
                  onChange={(value) => setAssignment({ strategy: value as HarnessAssignmentStrategy })}
                />
              </Form.Item>
            </Col>
            <Col xs={24} sm={12}>
              <Form.Item label="unmatched fallback">
                <Select
                  aria-label="Agent assignment fallback"
                  value={draft.assignment.fallback ?? "error"}
                  options={[
                    { value: "error", label: "error（服务端拒绝）" },
                    { value: "profile-rotation", label: "profile rotation（显式兼容）" }
                  ]}
                  disabled={disabled}
                  onChange={(value) => setAssignment({ fallback: value as "profile-rotation" | "error" })}
                />
              </Form.Item>
            </Col>
          </Row>
          {draft.assignment.strategy === "seat" ? (
            <Row gutter={[8, 8]}>
              {Array.from({ length: 9 }, (_, index) => index + 1).map((seat) => (
                <Col xs={12} sm={8} key={seat}>
                  <Form.Item label={`seat ${seat}`} style={{ marginBottom: 8 }}>
                    <Select
                      aria-label={`Agent assignment seat ${seat}`}
                      allowClear
                      value={draft.assignment.seats?.[String(seat)]}
                      options={profileOptions}
                      disabled={disabled}
                      onChange={(value) => setSeatProfile(seat, value ? String(value) : undefined)}
                    />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          ) : null}
          {draft.assignment.strategy === "role" ? (
            <Row gutter={[8, 8]}>
              {WEREWOLF_ROSTER_ROLES.map((role) => (
                <Col xs={24} sm={12} key={role}>
                  <Form.Item label={role} style={{ marginBottom: 8 }}>
                    <Select
                      aria-label={`Agent assignment role ${role}`}
                      allowClear
                      value={typeof draft.assignment.roles?.[role] === "string" ? draft.assignment.roles?.[role] : undefined}
                      options={profileOptions}
                      disabled={disabled}
                      onChange={(value) => setRoleProfile(role, value ? String(value) : undefined)}
                    />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          ) : null}
          {draft.assignment.strategy === "team" ? (
            <Row gutter={[8, 8]}>
              {WEREWOLF_ROSTER_TEAMS.map((team) => (
                <Col xs={24} sm={12} key={team}>
                  <Form.Item label={team} style={{ marginBottom: 8 }}>
                    <Select
                      aria-label={`Agent assignment team ${team}`}
                      allowClear
                      value={typeof draft.assignment.teams?.[team] === "string" ? draft.assignment.teams?.[team] : undefined}
                      options={profileOptions}
                      disabled={disabled}
                      onChange={(value) => setTeamProfile(team, value ? String(value) : undefined)}
                    />
                  </Form.Item>
                </Col>
              ))}
            </Row>
          ) : null}
        </Form>
      </Card>
      <Flex justify="flex-end" gap="small">
        <Button onClick={onClose}>完成编排</Button>
      </Flex>
    </Space>
  );
}
