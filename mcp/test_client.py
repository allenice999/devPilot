import asyncio

from fastmcp import Client


async def main():
    async with Client("http://127.0.0.1:8001/mcp") as client:
        tools = await client.list_tools()
        print("Tools:", [tool.name for tool in tools])
        result = await client.call_tool("ping", {})
        print("Ping result:", result)


if __name__ == "__main__":
    asyncio.run(main())

