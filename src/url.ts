/** The url without its trailing slashes ('http://x///' -> 'http://x'), in linear time with no regex backtracking. */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url[end - 1] === '/') end--;
  return url.slice(0, end);
}
