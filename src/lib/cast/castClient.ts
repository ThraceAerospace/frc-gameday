let session: any = null;

export async function startCastSession() {
  const context = (window as any).cast.framework.CastContext.getInstance();

  context.setOptions({
    receiverApplicationId: process.env.NEXT_PUBLIC_CAST_APP_ID,
    autoJoinPolicy: (window as any).chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
  });

  session = await context.requestSession();

  return session;
}

export function sendCastState(state: any) {
  if (!session) return;

  session.sendMessage("urn:x-cast:frc.multiview", state);
}