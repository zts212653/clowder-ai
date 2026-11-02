/** Simulate a current API client reading the resource before a member mutation. */
export async function readMemberRequestRevision(app, url, headers) {
  const catId = new URL(url, 'http://member.test').pathname.split('/').at(-1);
  const response = await app.inject({ method: 'GET', url: '/api/cats', headers });
  return response.json().cats?.find((cat) => cat.id === catId)?.configurationRevision;
}
