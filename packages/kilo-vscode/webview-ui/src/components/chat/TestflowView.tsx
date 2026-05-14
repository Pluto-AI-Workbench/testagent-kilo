// testagent_change - new file
import { Show, For, type Component } from "solid-js"
import { Button } from "@kilocode/kilo-ui/button"
import { Icon } from "@kilocode/kilo-ui/icon"
import { Spinner } from "@kilocode/kilo-ui/spinner"
import { useTestflow } from "../../context/testflow"

export const TestflowView: Component = () => {
  const tf = useTestflow()
  const s = tf.state

  return (
    <Show when={s().running || s().done || s().error}>
      <div class="testflow-panel" data-component="testflow-panel">
        <div class="testflow-header">
          <Show when={s().running} fallback={
            <Show when={s().error} fallback={
              <span class="testflow-status">
                <Show when={s().exitCode === 0} fallback={
                  <Icon name="x-circle" size="small" />
                }>
                  <Icon name="check-circle" size="small" />
                </Show>
                {" "}Testflow {s().exitCode === 0 ? "完成" : "失败"}
              </span>
            }>
              <span class="testflow-status testflow-error">
                <Icon name="alert-triangle" size="small" /> 错误: {s().error}
              </span>
            </Show>
          }>
            <span class="testflow-status testflow-running">
              <Spinner class="chat-spinner-small" /> Testflow 运行中...
            </span>
          </Show>
          <Show when={s().running}>
            <Button variant="ghost" size="small" onClick={tf.abort}>
              终止
            </Button>
          </Show>
        </div>

        <Show when={s().steps.length > 0}>
          <div class="testflow-steps">
            <For each={s().steps}>
              {(step) => (
                <div class="testflow-step" data-status={step.status}>
                  <Show when={step.status === "start"} fallback={
                    <Show when={step.status === "complete"} fallback={
                      <Icon name="alert-triangle" size="small" />
                    }>
                      <Icon name="check" size="small" />
                    </Show>
                  }>
                    <Spinner class="chat-spinner-small" />
                  </Show>
                  <span>{step.title}</span>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={s().agentRunning}>
          <div class="testflow-agent">
            <Spinner class="chat-spinner-small" />
            <span>AI Agent 执行中{ s().agentSkill ? ` (${s().agentSkill})` : ""}...</span>
          </div>
        </Show>

        <Show when={s().question}>
          <div class="testflow-question">
            <div class="testflow-question-header">{s().question!.header}</div>
            <div class="testflow-question-body">{s().question!.question}</div>
            <div class="testflow-question-options">
              <For each={s().question!.options}>
                {(opt) => (
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => tf.reply(s().question!.id, [opt.label])}
                  >
                    {opt.label}
                  </Button>
                )}
              </For>
            </div>
            <div class="testflow-question-actions">
              <Button variant="ghost" size="small" onClick={() => tf.reject(s().question!.id)}>
                取消
              </Button>
            </div>
          </div>
        </Show>

        <Show when={s().summary}>
          <div class="testflow-summary">{s().summary}</div>
        </Show>
      </div>
    </Show>
  )
}
