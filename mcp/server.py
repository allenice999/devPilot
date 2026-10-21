from fastmcp import FastMCP

mcp = FastMCP("DevPilot MCP")


@mcp.tool
def ping() -> str:
    """Check whether the DevPilot MCP server is responding."""
    return "pong"


if __name__ == "__main__":
    mcp.run(
        transport="http",
        host="0.0.0.0",
        port=8001,
        show_banner=False,
    )

