/** Maps a CrankService.registerMarket result to the POST /register HTTP response (status + masked body). */
export function registerResponse(result: { success: boolean; message: string }): { status: number; body: { success: boolean; message: string } } {
  return {
    status: result.success ? 200 : 422,
    body: { success: result.success, message: result.success ? result.message : "Registration failed" },
  };
}
