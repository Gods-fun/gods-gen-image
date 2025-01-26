import { useQuery } from "@tanstack/react-query";
import type { CustomQueryResult } from "../types";
import { Queries } from "./queries";
import { ROUTES } from "../routes";

export type Agent = {
    id: string;
    name: string;
};

export const useGetAgentsQuery = (): CustomQueryResult<Agent[] | undefined> => {
    return useQuery({
        queryKey: [Queries.AGENTS],
        queryFn: async () => {
            try {
                console.log('Fetching agents from:', ROUTES.getAgents());
                const res = await fetch(ROUTES.getAgents());
                
                if (!res.ok) {
                    throw new Error(`HTTP error! status: ${res.status}`);
                }
                
                const data = await res.json();
                console.log('Received agents data:', data);
                return data.agents as Agent[];
            } catch (error) {
                console.error('Error fetching agents:', error);
                throw error;
            }
        },
        retry: (failureCount) => failureCount < 3,
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
    });
};
