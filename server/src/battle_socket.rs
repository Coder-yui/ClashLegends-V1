//! A live socket owns its readiness lease and the cursor of its last successful write.
use super::*;

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Signal {
    Ready { protocol: u32 },
}
#[derive(Deserialize)]
struct Stamped {
    #[serde(rename = "inputTick")]
    input_tick: u64,
    #[serde(flatten)]
    command: Command,
}

async fn send_frame(
    socket: &mut WebSocket,
    frames: &mut watch::Receiver<Arc<SeatFrame>>,
    cursor: &mut Option<u64>,
) -> bool {
    let frame = frames.borrow_and_update().clone();
    if socket
        .send(Message::Text(frame.encode(*cursor).into()))
        .await
        .is_err()
    {
        return false;
    }
    *cursor = Some(frame.history.cursor);
    true
}

pub(super) async fn stream(
    mut socket: WebSocket,
    seat: usize,
    mut frames: watch::Receiver<Arc<SeatFrame>>,
    ready: watch::Sender<()>,
    queue: mpsc::Sender<Request>,
) {
    // Let the client draw and warm its opening scene without acquiring a ready lease.
    let preview = frames.borrow().pending();
    let hello = json!({"type":"connected","protocol":PROTOCOL,"preview":preview});
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return;
    }
    let mut readiness = None;
    let mut cursor = None;
    if preview && !send_frame(&mut socket, &mut frames, &mut cursor).await {
        return;
    }
    loop {
        tokio::select! {
            changed = frames.changed() => {
                if changed.is_err() { return; }
                if readiness.is_some() && !send_frame(&mut socket, &mut frames, &mut cursor).await { return; }
            }
            message = socket.recv() => match message {
                Some(Ok(Message::Text(raw))) => {
                    if let Ok(Signal::Ready { protocol }) = serde_json::from_str(&raw) {
                        if protocol != PROTOCOL { return; }
                        if readiness.is_none() {
                            cursor = None;
                            readiness = Some(ready.subscribe());
                            if !send_frame(&mut socket, &mut frames, &mut cursor).await { return; }
                        }
                        continue;
                    }
                    let admitted = match (readiness.is_some(), serde_json::from_str::<Stamped>(&raw)) {
                        (false, _) => Err("本连接尚未完成战场准备"),
                        (_, Err(_)) => Err("无效指令"),
                        (_, Ok(Stamped { input_tick, command })) => {
                            let (reply, answer) = oneshot::channel();
                            match queue.try_send(Request { input:Logged { seat,input_tick,command }, reply }) {
                                Ok(()) => match answer.await { Ok(receipt) => receipt, Err(_) => continue },
                                Err(mpsc::error::TrySendError::Full(_)) => Err("输入队列已满"),
                                Err(mpsc::error::TrySendError::Closed(_)) => continue,
                            }
                        }
                    };
                    let receipt = json!({"type":"receipt","error":admitted.err(),"executeTick":admitted.ok()});
                    if socket.send(Message::Text(receipt.to_string().into())).await.is_err() {return;}
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_))) => (),
                _ => return,
            }
        }
    }
}
