use crate::util::uuid;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn is_gemini(m: &str) -> bool {
    m.to_ascii_lowercase().starts_with("gemini")
}

pub fn agy_args(prompt: &str, model: &str, mode: &str, conversation: Option<&str>) -> Vec<String> {
    let mut a = vec![format!("--prompt={prompt}"), "--output-format".into(), "stream-json".into()];
    if !model.is_empty() {
        a.extend(["--model".into(), model.into()]);
    }
    a.extend(
        match mode {
            "auto" => vec!["--mode", "auto"],
            "plan" => vec!["--mode", "plan"],
            "bypassPermissions" => vec!["--dangerously-skip-permissions"],
            _ => vec!["--mode", "accept-edits"],
        }
        .into_iter()
        .map(String::from),
    );
    if let Some(c) = conversation.filter(|c| !c.is_empty()) {
        a.extend(["--conversation".into(), c.into()]);
    }
    a
}

pub fn parse_agy_models(stdout: &str) -> Vec<Value> {
    let re = Regex::new(r"^(gemini-[\w.-]+)\t(.+)$").unwrap();
    let mut seen = HashSet::new();
    stdout
        .lines()
        .filter_map(|l| re.captures(l))
        .filter(|c| seen.insert(c[1].to_string()))
        .map(|c| json!({ "value": &c[1], "displayName": &c[2], "description": format!("{} · Antigravity", &c[2]), "supportsFastMode": false, "supportsEffort": false }))
        .collect()
}

#[derive(Default)]
pub struct Turn {
    pub text: String,
    pub streaming: bool,
    pub conversation_id: Option<String>,
    pub tokens: i64,
    pub error: Option<String>,
}

fn stream_event(e: Value) -> Value {
    json!({ "type": "stream_event", "event": e })
}

fn assistant(content: Value) -> Value {
    json!({ "type": "assistant", "uuid": uuid(), "message": { "content": content } })
}

impl Turn {
    pub fn new(conversation_id: Option<String>, tokens: i64) -> Self {
        Turn { conversation_id, tokens, ..Default::default() }
    }

    pub fn finish(&mut self) -> Vec<Value> {
        let text = self.text.trim().to_string();
        self.text.clear();
        self.streaming = false;
        if text.is_empty() { vec![] } else { vec![assistant(json!([{ "type": "text", "text": text }]))] }
    }

    fn step(&mut self, u: &Value) -> Vec<Value> {
        let conv = u["conversation_id"].as_str().map(String::from).or(self.conversation_id.clone()).unwrap_or_default();
        let id = format!("{conv}:{}", u["step_index"]);
        let state = u["state"].as_str().unwrap_or_default();
        match u["step_type"].as_str() {
            Some("agent_response") => {
                let mut out = vec![];
                let delta = u["text_delta"].as_str().unwrap_or_default();
                if !delta.is_empty() && (self.streaming || !delta.trim().is_empty()) {
                    if !self.streaming {
                        out.push(stream_event(json!({ "type": "message_start" })));
                        out.push(stream_event(json!({ "type": "content_block_start", "content_block": { "type": "text" } })));
                    }
                    self.streaming = true;
                    self.text.push_str(delta);
                    out.push(stream_event(json!({ "type": "content_block_delta", "delta": { "type": "text_delta", "text": delta } })));
                }
                if state == "DONE" {
                    if u["usage"].is_object() {
                        self.tokens = u["usage"]["input_tokens"].as_i64().unwrap_or(0) + u["usage"]["output_tokens"].as_i64().unwrap_or(0);
                    }
                    out.extend(self.finish());
                }
                out
            }
            Some("tool") if state == "ACTIVE" => {
                let input = if u["tool_info"]["parameters"].is_null() { json!({}) } else { u["tool_info"]["parameters"].clone() };
                let mut out = self.finish();
                out.push(assistant(json!([{ "type": "tool_use", "id": id, "name": u["tool_name"], "input": input }])));
                out
            }
            Some("tool") if state == "DONE" => {
                let output = match &u["tool_info"]["output"] {
                    Value::Null => String::new(),
                    Value::String(s) => s.clone(),
                    v => v.to_string(),
                };
                vec![json!({ "type": "user", "uuid": uuid(), "message": { "content": [{ "type": "tool_result", "tool_use_id": id, "content": output, "is_error": false }] } })]
            }
            _ => vec![],
        }
    }

    pub fn translate(&mut self, ev: &Value) -> Vec<Value> {
        match ev["event"].as_str() {
            Some("init") => {
                if let Some(c) = ev["conversation_id"].as_str() {
                    self.conversation_id = Some(c.into());
                }
                vec![]
            }
            Some("step_update") => self.step(&ev["step_update"]),
            Some("result") => {
                let r = &ev["result"];
                if let Some(c) = r["conversation_id"].as_str() {
                    self.conversation_id = Some(c.into());
                }
                if r["status"] != "SUCCESS" && self.error.is_none() {
                    self.error = r["error"].as_str().or(r["status"].as_str()).map(String::from).or(Some("Antigravity failed".into()));
                }
                let mut out = self.finish();
                for d in r["denied_actions"].as_array().into_iter().flatten() {
                    out.push(json!({ "type": "system", "subtype": "permission_denied", "tool_name": d["display_name"].as_str().or(d["action"].as_str()) }));
                }
                out
            }
            _ => vec![],
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run_fixture() -> (Turn, Vec<Value>) {
        let mut st = Turn::new(None, 0);
        let fixture = include_str!("../tests/fixtures/agy-stream.ndjson");
        let mut out: Vec<Value> = fixture.lines().flat_map(|l| st.translate(&serde_json::from_str(l).unwrap_or(Value::Null))).collect();
        out.extend(st.finish());
        (st, out)
    }

    fn blocks(out: &[Value], t: &str) -> Vec<Value> {
        out.iter().filter(|m| m["type"] == t).flat_map(|m| m["message"]["content"].as_array().unwrap().clone()).collect()
    }

    #[test]
    fn fixture_yields_conversation_id_tokens_and_no_error() {
        let (st, _) = run_fixture();
        assert_eq!(st.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(st.tokens, 14069);
        assert!(st.error.is_none());
    }

    #[test]
    fn text_streams_as_deltas_and_lands_in_one_assistant_message() {
        let (_, out) = run_fixture();
        let deltas: String = out.iter().filter(|m| m["event"]["type"] == "content_block_delta").map(|m| m["event"]["delta"]["text"].as_str().unwrap()).collect();
        assert_eq!(deltas, "Version set to 0.2.0.\n");
        assert_eq!(out.iter().filter(|m| m["event"]["type"] == "message_start").count(), 1);
        let texts: Vec<_> = blocks(&out, "assistant").into_iter().filter(|b| b["type"] == "text").map(|b| b["text"].clone()).collect();
        assert_eq!(texts, [json!("Version set to 0.2.0.")]);
    }

    #[test]
    fn every_tool_step_becomes_a_tool_use_then_a_matching_tool_result() {
        let (_, out) = run_fixture();
        let uses: Vec<_> = blocks(&out, "assistant").into_iter().filter(|b| b["type"] == "tool_use").collect();
        let ids: Vec<_> = uses.iter().map(|u| (u["id"].as_str().unwrap().to_string(), u["name"].as_str().unwrap().to_string())).collect();
        assert_eq!(ids, [("conv-1:2".into(), "view_file".into()), ("conv-1:4".into(), "replace_file_content".into()), ("conv-1:5".to_string(), "run_command".to_string())]);
        assert_eq!(uses[2]["input"], json!({ "CommandLine": "ls -la" }));
        let results: Vec<_> = blocks(&out, "user").iter().map(|r| json!([r["tool_use_id"], r["content"], r["is_error"]])).collect();
        assert_eq!(results, [json!(["conv-1:2", "2 lines, 20 bytes", false]), json!(["conv-1:4", "", false]), json!(["conv-1:5", "", false])]);
        assert!(out.iter().filter(|m| m["type"] == "assistant" || m["type"] == "user").all(|m| m["uuid"].is_string()));
    }

    #[test]
    fn denied_actions_surface_as_permission_denied_notices() {
        let (_, out) = run_fixture();
        let sys: Vec<_> = out.into_iter().filter(|m| m["type"] == "system").collect();
        assert_eq!(sys, [json!({ "type": "system", "subtype": "permission_denied", "tool_name": "RunCommand" })]);
    }

    #[test]
    fn unknown_events_garbage_and_echoes_produce_nothing() {
        let mut st = Turn::new(None, 0);
        assert!(st.translate(&json!({ "event": "heartbeat" })).is_empty());
        assert!(st.translate(&Value::Null).is_empty());
        assert!(st.translate(&json!({ "event": "step_update", "step_update": { "step_type": "user_input", "state": "DONE", "step_index": 0 } })).is_empty());
        assert!(st.translate(&json!({ "event": "step_update", "step_update": { "step_type": "agent_response", "state": "DONE", "step_index": 1, "text_delta": "\n" } })).is_empty());
    }

    #[test]
    fn finish_flushes_partial_text_once() {
        let mut st = Turn::new(Some("c".into()), 0);
        st.translate(&json!({ "event": "step_update", "step_update": { "step_type": "agent_response", "state": "ACTIVE", "step_index": 1, "text_delta": "partial" } }));
        assert_eq!(st.finish()[0]["message"]["content"][0]["text"], "partial");
        assert!(st.finish().is_empty());
    }

    #[test]
    fn error_result_sets_error_success_does_not() {
        let mut st = Turn::new(None, 0);
        st.translate(&json!({ "event": "result", "result": { "status": "SUCCESS", "response": "" } }));
        assert!(st.error.is_none());
        st.translate(&json!({ "event": "result", "result": { "status": "ERROR", "error": "invalid model selection" } }));
        assert_eq!(st.error.as_deref(), Some("invalid model selection"));
    }

    #[test]
    fn agy_args_map_permission_modes_and_resume() {
        let m = "gemini-3.8-flash-high";
        assert_eq!(agy_args("hi", m, "auto", None), ["--prompt=hi", "--output-format", "stream-json", "--model", m, "--mode", "auto"]);
        for (mode, tail) in [("default", "accept-edits"), ("acceptEdits", "accept-edits"), ("plan", "plan"), ("weird", "accept-edits")] {
            assert_eq!(agy_args("hi", m, mode, None)[5..], ["--mode", tail]);
        }
        assert_eq!(agy_args("hi", m, "bypassPermissions", None).last().unwrap(), "--dangerously-skip-permissions");
        assert_eq!(agy_args("hi", m, "default", Some("c1"))[7..], ["--conversation", "c1"]);
        assert_eq!(agy_args("--help -rf", "", "default", None)[0], "--prompt=--help -rf");
        assert!(!agy_args("x", "", "default", None).contains(&"--model".to_string()));
    }

    #[test]
    fn parse_agy_models_keeps_unique_gemini_models() {
        let out = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\ngemini-3.8-flash-high\tdup\n";
        let models = parse_agy_models(out);
        assert_eq!(models.iter().map(|m| m["value"].as_str().unwrap()).collect::<Vec<_>>(), ["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
        assert_eq!(models[0]["displayName"], "Gemini 3.8 Flash (High)");
        assert_eq!(models[0]["description"], "Gemini 3.8 Flash (High) · Antigravity");
        assert_eq!(models[0]["supportsEffort"], false);
        assert!(parse_agy_models("Error: Please sign in to view available models.").is_empty());
        assert!(is_gemini("Gemini-x") && !is_gemini("opus"));
    }
}
