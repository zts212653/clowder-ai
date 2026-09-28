export function F307OwnerUnavailable({ message }: { message: string }) {
  return (
    <div className="grid h-full min-h-52 place-items-center p-6 text-center" data-testid="f307-owner-unavailable">
      <div>
        <p className="text-sm font-semibold text-cafe">这个对象目前无法恢复</p>
        <p className="mt-1 max-w-sm text-xs leading-5 text-cafe-muted">{message}</p>
      </div>
    </div>
  );
}
