use super::*;
use axum::http::header::SET_COOKIE;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Deserialize)]
pub(crate) struct Entry {
    role: String,
    digest: String,
}
pub(crate) type Registry = BTreeMap<String, Entry>;

pub(crate) fn registry() -> Registry {
    let Some(path) = std::env::var_os("LOBBY_ACCOUNTS_FILE") else {
        return Registry::new();
    };
    let entries: Registry =
        serde_json::from_slice(&std::fs::read(path).expect("read account registry"))
            .expect("parse account registry");
    assert!(
        entries.values().filter(|v| v.role == "admin").count() == 1
            && entries.iter().all(|(name, v)| !name.is_empty()
                && name.len() <= 32
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                && matches!(v.role.as_str(), "admin" | "beta")
                && v.digest.len() == 64
                && v.digest.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid account registry"
    );
    entries
}
pub(crate) async fn identity(app: &App, h: &HeaderMap) -> Result<Option<(String, String)>> {
    let Some(key) = cookie(h, "clash_account=") else {
        return Ok(None);
    };
    if app.accounts.is_empty() {
        return Ok(None);
    }
    let db = app.db.get().await?;
    let row = db
        .query_opt(
            "SELECT player FROM account_sessions WHERE token=$1 AND expires_at>now()",
            &[&key],
        )
        .await?;
    Ok(row.and_then(|r| {
        let p: String = r.get(0);
        let role = &app.accounts.get(p.strip_prefix("account/")?)?.role;
        Some((p, role.clone()))
    }))
}
fn set_cookie(h: &HeaderMap, key: &str, ttl: i64) -> Response {
    let mut response = Json(json!({})).into_response();
    let host = h
        .get("host")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.parse::<axum::http::uri::Authority>().ok());
    let secure = if host.is_some_and(|h| matches!(h.host(), "127.0.0.1" | "localhost" | "[::1]")) {
        ""
    } else {
        "; Secure"
    };
    response.headers_mut().insert(
        SET_COOKIE,
        format!("clash_account={key}; HttpOnly; Path=/; SameSite=Strict; Max-Age={ttl}{secure}")
            .parse()
            .unwrap(),
    );
    response
}
#[derive(Deserialize)]
pub struct Login {
    name: String,
    key: String,
}
pub async fn login(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<Login>,
) -> Result<Response> {
    session::check_origin(&h)?;
    let digest: String = Sha256::digest(input.key.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    if !app
        .accounts
        .get(&input.name)
        .is_some_and(|v| v.digest == digest)
    {
        return Err(Error(StatusCode::UNAUTHORIZED, "账号或登录密钥有误".into()));
    }
    let p = format!("account/{}", input.name);
    let mut db = app.db.get().await?;
    let tx = db.transaction().await?;
    tx.execute(
        "INSERT INTO guests(id,name,token) VALUES ($1,$2,$3) ON CONFLICT(id) DO NOTHING",
        &[&p, &input.name, &id()],
    )
    .await?;
    tx.execute(
        "INSERT INTO account_data(player) VALUES($1) ON CONFLICT DO NOTHING",
        &[&p],
    )
    .await?;
    tx.execute(
        "DELETE FROM account_sessions WHERE expires_at<=now() OR token=$1",
        &[&cookie(&h, "clash_account=").unwrap_or("")],
    )
    .await?;
    let key = id();
    tx.execute("INSERT INTO account_sessions(token,player,expires_at) VALUES($1,$2,now()+interval '30 days')", &[&key,&p]).await?;
    tx.commit().await?;
    Ok(set_cookie(&h, &key, 30 * 86400))
}
pub async fn logout(State(app): State<App>, h: HeaderMap) -> Result<Response> {
    session::check_origin(&h)?;
    app.db
        .get()
        .await?
        .execute(
            "DELETE FROM account_sessions WHERE token=$1",
            &[&cookie(&h, "clash_account=").unwrap_or("")],
        )
        .await?;
    Ok(set_cookie(&h, "", 0))
}
#[derive(Deserialize)]
pub struct Update {
    owner: String,
    field: String,
    before: Value,
    value: Value,
}
pub async fn save(
    State(app): State<App>,
    h: HeaderMap,
    Json(input): Json<Update>,
) -> Result<Json<Value>> {
    session::check_origin(&h)?;
    let (p, _) = identity(&app, &h)
        .await?
        .ok_or_else(|| Error(StatusCode::UNAUTHORIZED, "请重新登录账号".into()))?;
    if p.strip_prefix("account/") != Some(input.owner.as_str()) {
        return Err(fail("当前登录的账号已更改"));
    }
    let val = &input.value;
    let field = input.field.as_str();
    let slot = ["slot0", "slot1", "slot2", "slot3"]
        .iter()
        .position(|&s| s == field);
    if slot.is_some() {
        let name = val["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.chars().count() > 8 {
            return Err(fail("卡组名限 1 至 8 个字"));
        }
        let deck = decode(val["deck"].clone())?;
        app.collection
            .check_preset(&deck)
            .or_else(|_| app.catalog.check_preset(&deck))?;
    } else if field == "profile" {
        let avatar = val["avatar"].as_str().ok_or_else(|| fail("请选择头像"))?;
        let upload = avatar
            .strip_prefix("data:image/webp;base64,")
            .is_some_and(|data| {
                data.starts_with("UklGR")
                    && data.len() <= 60000
                    && data
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
            });
        if (!avatar.is_empty() && !upload && !app.collection.cards.iter().any(|c| c.id == avatar))
            || !val["bio"]
                .as_str()
                .is_some_and(|s| s.chars().count() <= 120)
        {
            return Err(fail("头像或简介无效"));
        }
    } else if field != "preferences" || !val.is_object() {
        return Err(fail("未知设置"));
    }
    if val.to_string().len() > if field == "profile" { 65536 } else { 8192 } {
        return Err(fail("设置过长"));
    }
    let mut patch = json!({field: val});
    if let Some(index) = slot {
        patch["active"] = json!(index);
    }
    let rows = app.db.get().await?.execute("UPDATE account_data SET fields=fields || $1 WHERE player=$2 AND (COALESCE(fields->$3::text, 'null'::jsonb)=$4 OR fields->$3::text=$5)", &[&patch,&p,&field,&input.before,&val]).await?;
    if rows == 0 {
        return Err(fail("这项记录已在其他页面更改，请重新载入后保存"));
    }
    let _ = app.changes.send(p);
    Ok(Json(json!({})))
}
