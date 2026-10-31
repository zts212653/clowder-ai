/**
 * Words for why a chosen place (in a file or on a picture) was not put into the chat input, in the person's terms.
 * One place so every surface says the same thing; kept free of any store so pure decisions can use it.
 */

/** The input with the place applied would no longer be a collection one message can carry. */
export const COMPOSER_TOO_LARGE_COPY = '输入框里的引用合起来超出了一条消息能带的上限，请先发送或移除几个。';

/** The input has not yet taken the answer to a recall waiting for it; the place can be added a moment later. */
export const COMPOSER_RECALL_PENDING_COPY = '正在恢复上一条消息的内容，请稍后再引用一次。';
